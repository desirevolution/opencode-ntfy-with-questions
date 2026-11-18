/**
 * Transport Adapter layer: the seam between the notification handlers and the
 * active Transport. Handlers depend on the TransportAdapter interface only —
 * never on a channel's client directly. Exactly one Transport is active per
 * instance, selected by the `transport` config key (default ntfy).
 */

import type { Agent } from "node:https"

import { createGotifyClient, describeGotifyError } from "./gotify-client.js"
import { createNtfyClient, describeNtfyError, type FetchLike } from "./ntfy-client.js"
import { createWebPushTransport } from "./webpush-transport.js"
import type {
  GotifySettings,
  Logger,
  NotificationDraft,
  NtfySettings,
  PluginConfig,
} from "./types.js"

/**
 * The Adapter behind which every Transport hides. `publish` sends one
 * Notification draft; `describeError` renders a publish failure as a log-safe
 * description that never contains secrets, headers or payloads.
 */
export interface TransportAdapter {
  publish(draft: NotificationDraft): Promise<void>
  describeError(error: unknown): string
}

/**
 * Injectable boundaries of the Transport Adapters; tests observe requests
 * here. The webpush Adapter reports per-Subscription failures on `log` and
 * sends through `agent` (tests trust a local self-signed endpoint with it).
 */
export interface TransportDeps {
  fetch?: FetchLike
  log?: Logger
  agent?: Agent
}

/**
 * The ntfy Adapter: wraps today's publish client with unchanged behavior —
 * same request shape, same per-publish timeout, same fail-open semantics and
 * the same concurrency bounds (which live in the shared handler gate).
 */
export function createNtfyTransport(settings: NtfySettings, deps: TransportDeps = {}): TransportAdapter {
  const client = createNtfyClient(settings, deps)
  return {
    publish: (draft) => client.publish({ title: draft.title, message: draft.message, tags: draft.tags, kind: draft.kind }),
    describeError: describeNtfyError,
  }
}

/**
 * The Gotify Adapter: posts to the configured server's `message` endpoint with
 * the app token in the `X-Gotify-Key` header (never the URL), title, message
 * and mapped integer priority in the body. Same bounded, fail-open publish
 * contract as ntfy; the shared concurrency bounds live in the handler gate.
 */
export function createGotifyTransport(settings: GotifySettings, deps: TransportDeps = {}): TransportAdapter {
  const client = createGotifyClient(settings, deps)
  return {
    publish: (draft) => client.publish({ title: draft.title, message: draft.message }),
    describeError: describeGotifyError,
  }
}

/**
 * Creates the Adapter of the configured active Transport. The switch must stay
 * exhaustive over the transport config enum so adding a Transport without an
 * Adapter fails the typecheck. The PluginConfig union is used directly: with
 * per-Transport sections, the active Transport's section is exactly the one
 * present.
 */
export function createTransport(config: PluginConfig, deps: TransportDeps = {}): TransportAdapter {
  switch (config.transport) {
    case "ntfy":
      return createNtfyTransport(config.ntfy, deps)
    case "gotify":
      return createGotifyTransport(config.gotify, deps)
    case "webpush":
      return createWebPushTransport(config.webpush, deps)
  }
}
