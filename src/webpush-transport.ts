/**
 * The Web Push Adapter (ADR-0001): delivers one Notification draft to every
 * Subscription in the Subscription Store via the `web-push` library.
 *
 * Publish contract, shared with the ntfy Adapter:
 * - The Subscription Store is read fresh per publish, so registrations take
 *   effect without restarting opencode.
 * - Failures are isolated per Subscription: one dead device never stops the
 *   others. Every publish failure is logged, never thrown at the handler
 *   beyond the aggregate "nothing delivered" case the handler already logs.
 * - The whole fan-out is bounded by the configured publish deadline (same
 *   timeoutMs semantics as the other Adapters).
 * - Every push carries the Notification content, so the browser shows a
 *   visible Notification (which is also what keeps the Subscription alive).
 *
 * Secrecy discipline: log lines and error descriptions never contain
 * endpoint URLs (they carry the subscription's secret token), key material,
 * or payload content.
 */

import { sendNotification, WebPushError } from "web-push"
import type { Agent } from "node:https"

import { readSubscriptions, removeSubscriptions, type PushSubscriptionEntry } from "./subscription-store.js"
import { truncateUtf8 } from "./ntfy-client.js"
import { MAX_MESSAGE_BYTES, MAX_TITLE_BYTES, type NotificationDraft, type WebPushSettings } from "./types.js"
import type { TransportAdapter, TransportDeps } from "./transport.js"

/** Push messages expire from the push service after one hour. */
const TTL_SECONDS = 3600

/**
 * Upper bound for the JSON payload plaintext. Push services cap the encrypted
 * body at 4096 bytes; the aes128gcm envelope adds an 86-byte header (16 salt
 * + 4 record size + 1 key length + 65 key id) and 17 bytes of record overhead
 * (1 padding delimiter + 16 auth tag). 3990 keeps a small margin.
 */
const MAX_PAYLOAD_PLAINTEXT_BYTES = 3990

/** Base class for webpush publish failures; messages never contain secrets. */
export class WebPushPublishError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class WebPushTimeoutError extends WebPushPublishError {}
export class WebPushFanoutError extends WebPushPublishError {}

export interface WebPushTransportDeps extends TransportDeps {
  /**
   * Injectable https.Agent for the sender. web-push sends over HTTPS only,
   * so tests point it at a local HTTPS endpoint with a self-signed cert via
   * an agent with rejectUnauthorized disabled.
   */
  agent?: Agent
  /** Secret-safe log sink for per-Subscription failures and store upkeep. */
  log?: (message: string) => void
}

/**
 * Renders a per-Subscription failure for the log. Endpoint URLs, response
 * bodies and key material are never included.
 */
function describeSubscriptionFailure(error: unknown): string {
  if (error instanceof WebPushError) return `HTTP status ${error.statusCode}`
  if (error instanceof WebPushTimeoutError) return "timed out"
  // A foreign error's message could embed the endpoint or payload: fixed text.
  return "request failed"
}

/**
 * Produces a log-safe description of a publish failure. The result never
 * includes endpoints, headers, bodies, key material or payloads.
 */
export function describeWebpushError(error: unknown): string {
  if (error instanceof WebPushError) return `webpush push service responded with HTTP status ${error.statusCode}`
  if (error instanceof WebPushPublishError) return error.message
  return "unexpected webpush publish failure"
}

/**
 * Serializes the Notification draft into the encrypted payload. Both 4096
 * bytes (a visible Notification carrying the content) and the log-safe
 * truncated shapes of the other Adapters are honored: the title is truncated
 * like the ntfy client's, and an oversized message is cut back until the
 * whole payload fits below the push-service body limit.
 */
export function buildWebpushPayload(draft: NotificationDraft): string {
  const title = truncateUtf8(draft.title, MAX_TITLE_BYTES)
  const payloadFor = (message: string): string =>
    JSON.stringify({ kind: draft.kind, title, message, tags: draft.tags })
  let message = truncateUtf8(draft.message, MAX_MESSAGE_BYTES)
  let payload = payloadFor(message)
  while (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_PLAINTEXT_BYTES && message.length > 0) {
    const over = Buffer.byteLength(payload, "utf8") - MAX_PAYLOAD_PLAINTEXT_BYTES
    const target = Math.max(0, Buffer.byteLength(message, "utf8") - over - 64)
    message = truncateUtf8(message, target)
    payload = payloadFor(message)
  }
  return payload
}

/**
 * Creates the webpush Adapter bound to one config's settings. The store is
 * read at publish time from `settings.storePath`; `deps.agent` is only used
 * to trust the local self-signed test endpoint.
 */
export function createWebPushTransport(settings: WebPushSettings, deps: WebPushTransportDeps = {}): TransportAdapter {
  const log = deps.log
  const vapidDetails = { subject: settings.subject, publicKey: settings.publicKey, privateKey: settings.privateKey }

  const publish = async (draft: NotificationDraft): Promise<void> => {
    const subscriptions = await readSubscriptions(settings.storePath, { log })
    if (subscriptions.length === 0) {
      log?.(`webpush publish skipped: subscription store "${settings.storePath}" has no subscriptions`)
      return
    }

    const payload = buildWebpushPayload(draft)
    // One shared deadline bounds the whole fan-out. The library's own socket
    // timeout is set to the same value so in-flight requests self-terminate
    // instead of dangling past the publish.
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new WebPushTimeoutError(`webpush publish timed out after ${settings.timeoutMs}ms`))
      }, settings.timeoutMs)
    })

    let delivered = 0
    const expiredEndpoints = new Set<string>()
    const sendOne = async (subscription: PushSubscriptionEntry, index: number): Promise<void> => {
      try {
        const options = {
          vapidDetails,
          TTL: TTL_SECONDS,
          contentEncoding: "aes128gcm" as const,
          timeout: settings.timeoutMs,
          ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        }
        await Promise.race([sendNotification(subscription, payload, options), deadline])
        delivered += 1
      } catch (error) {
        if (error instanceof WebPushError && (error.statusCode === 410 || error.statusCode === 404)) {
          // Both statuses mean the Subscription is gone (RFC 8030): clean it
          // up so dead endpoints do not accumulate in the store.
          expiredEndpoints.add(subscription.endpoint)
          log?.(
            `webpush subscription ${index + 1} expired (HTTP status ${error.statusCode}); removing it from the subscription store`,
          )
        } else {
          log?.(`webpush subscription ${index + 1} failed: ${describeSubscriptionFailure(error)}`)
        }
      }
    }

    try {
      // Per-Subscription isolation: allSettled never short-circuits, and the
      // shared deadline aborts the wait for everyone at once.
      await Promise.race([Promise.allSettled(subscriptions.map(sendOne)), deadline])
    } catch {
      // The deadline won: fall through to the delivered-count check.
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    if (expiredEndpoints.size > 0) {
      await removeSubscriptions(settings.storePath, expiredEndpoints, { log })
    }

    if (delivered === 0) {
      if (timedOut) throw new WebPushTimeoutError(`webpush publish timed out after ${settings.timeoutMs}ms`)
      throw new WebPushFanoutError(`webpush publish failed for all ${subscriptions.length} subscriptions`)
    }
  }

  return { publish, describeError: describeWebpushError }
}
