/**
 * Minimal Gotify publishing client used by the plugin.
 *
 * Publishing uses a JSON POST to `<server>/message`; the application token
 * travels in the `X-Gotify-Key` request header — never a query parameter and
 * never logged. Only `fetch` and no third-party dependencies are used.
 */
import { MAX_MESSAGE_BYTES, MAX_TITLE_BYTES, type NtfyPriority, type GotifySettings } from "./types.js"
import { sanitizeTitle, truncateUtf8, type FetchLike } from "./ntfy-client.js"

export interface GotifyMessage {
  title: string
  message: string
  /** Overrides the configured priority for this one publish. */
  priority?: NtfyPriority
}

export interface GotifyClientDeps {
  fetch?: FetchLike
}

export interface GotifyClient {
  publish(message: GotifyMessage): Promise<void>
}

/**
 * Gotify priority is an integer (0-10); the plugin's named priority levels are
 * a config convenience and must be mapped immediately before serialization.
 * The scale is monotonic: higher means more urgent on the receiving device.
 */
export const GOTIFY_PRIORITY_LEVEL: Record<NtfyPriority, number> = {
  min: 0,
  low: 2,
  default: 4,
  high: 8,
  max: 10,
}

/** Base class for publish failures; messages never contain tokens or payloads. */
export class GotifyPublishError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}
export class GotifyTimeoutError extends GotifyPublishError {}
export class GotifyTransportError extends GotifyPublishError {}
export class GotifyHttpError extends GotifyPublishError {
  readonly status: number
  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options)
    this.status = status
  }
}

/**
 * Creates a publish client bound to one config's gotify settings. `fetch` is
 * injectable so tests can observe requests and simulate failures.
 */
export function createGotifyClient(settings: GotifySettings, deps: GotifyClientDeps = {}): GotifyClient {
  const fetchFn = deps.fetch ?? fetch
  const publish = async (message: GotifyMessage): Promise<void> => {
    // Bounded here, at the send boundary, so every caller is safe by default.
    const title = truncateUtf8(sanitizeTitle(message.title), MAX_TITLE_BYTES)
    // A per-message priority overrides the configured one; both are mapped
    // from the public name to Gotify's integer priority for the wire payload.
    const priority = GOTIFY_PRIORITY_LEVEL[message.priority ?? settings.priority]
    const body = JSON.stringify({
      title,
      message: truncateUtf8(message.message, MAX_MESSAGE_BYTES),
      priority,
    })
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Gotify-Key": settings.token,
    }
    // Explicit deadline: a fetchFn that never settles (or ignores its signal)
    // must not hang the hook. The deadline aborts the real request when it
    // wins, and the timer is cleared on every settled path.
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject first so the typed deadline wins the race; aborting first
          // could let a signal-observing fetch rejection beat the deadline.
          reject(new GotifyTimeoutError(`gotify publish timed out after ${settings.timeoutMs}ms`))
          controller.abort()
        }, settings.timeoutMs)
      })
      let response: Response
      try {
        response = await Promise.race([
          fetchFn(`${settings.server}message`, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }),
          deadline,
        ])
      } catch (error) {
        // The deadline rejects with GotifyTimeoutError; everything else is a
        // fixed transport failure. Foreign error names/messages/strings are
        // never inspected or interpolated, and Promise.race consumes any late
        // rejection so it cannot become an unhandled rejection.
        if (error instanceof GotifyTimeoutError) throw error
        throw new GotifyTransportError("gotify publish failed before a response was received", { cause: error })
      }
      if (!response.ok) {
        throw new GotifyHttpError(`gotify server responded with HTTP status ${response.status}`, response.status)
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return { publish }
}

/**
 * Produces a log-safe description of a publish failure. The result never
 * includes the token, headers, or the notification payload.
 */
export function describeGotifyError(error: unknown): string {
  if (error instanceof GotifyHttpError) return `gotify server responded with HTTP status ${error.status}`
  if (error instanceof GotifyTimeoutError) return error.message
  if (error instanceof GotifyTransportError) return error.message
  // Never surface a foreign Error.message: it could embed request payloads.
  return "unexpected gotify publish failure"
}
