/**
 * Shared types and constants for opencode-notifications-with-questions.
 */

export const notificationKinds = [
  "session.idle",
  "session.error",
  "permission.asked",
  "question.asked",
  "agent.notify",
] as const

export type NotificationKind = (typeof notificationKinds)[number]

/**
 * Default tool names whose `execute.before` calls are forwarded as
 * `agent.notify` notifications. These are NOT opencode built-ins: the tools
 * come from the user's own setup and are configurable for a reason.
 */
export const defaultAgentNotifyTools = ["opencode_notify", "openchamber_notify"] as const

/** Upper bound for the agentNotifyTools list. */
export const MAX_AGENT_NOTIFY_TOOLS = 16

/** Upper bound for one agentNotifyTools entry. */
export const MAX_AGENT_NOTIFY_TOOL_LENGTH = 64

/** Deadline for the idle-enrichment session context lookup in milliseconds. */
export const DEFAULT_SESSION_CONTEXT_TIMEOUT_MS = 2000

export const ntfyPriorities = ["min", "low", "default", "high", "max"] as const
export type NtfyPriority = (typeof ntfyPriorities)[number]

/**
 * Transports the plugin can activate, selected by the `transport` config key.
 * Exactly one Transport is active per instance.
 */
export const transports = ["ntfy", "gotify", "webpush"] as const
export type TransportName = (typeof transports)[number]

export const DEFAULT_TRANSPORT: TransportName = "ntfy"

/**
 * Config section names of the known Transports. A section belonging to an
 * inactive Transport must be absent or empty; the active Transport's section
 * is validated strictly.
 */
export const transportSectionNames = ["ntfy", "gotify", "webpush"] as const

/**
 * Fixed default ntfy tags per notification kind.
 */
export const kindTags: Record<NotificationKind, string> = {
  "session.idle": "hourglass_done",
  "session.error": "warning",
  "permission.asked": "lock",
  "question.asked": "question",
  "agent.notify": "bell",
}

/**
 * A sink for operational log lines. Log messages must stay secret-safe: they
 * never contain tokens, key material, endpoints or payloads.
 */
export type Logger = (message: string) => void

export interface NtfySettings {
  /** Normalized base URL with exactly one trailing slash. */
  server: string
  topic: string
  token?: string
  priority: NtfyPriority
  timeoutMs: number
}

export interface GotifySettings {
  /** Normalized base URL with exactly one trailing slash; the client appends `message`. */
  server: string
  /** Gotify application token. Sent as the `X-Gotify-Key` header, never in the URL and never logged. */
  token: string
  priority: NtfyPriority
  timeoutMs: number
}

/**
 * Settings of the webpush Transport: VAPID identity and the Subscription
 * Store file the Adapter reads fresh at publish time.
 */
export interface WebPushSettings {
  /**
   * VAPID subject: a contact URI (`mailto:` or `https://`) carried in the
   * push service-facing JWT. Not a secret, but never echoed in errors.
   */
  subject: string
  /** VAPID public key: base64url-encoded 65-byte uncompressed P-256 point. */
  publicKey: string
  /** VAPID private key: base64url-encoded 32 bytes. Never logged. */
  privateKey: string
  /**
   * Path of the Subscription Store file (JSON array of Subscriptions, written
   * by the Bootstrap Service) read fresh at publish time.
   */
  storePath: string
  /** Deadline in milliseconds bounding one whole fan-out publish. */
  timeoutMs: number
}

export interface SuppressSubagentSettings {
  "session.idle": boolean
  "session.error": boolean
}

/**
 * Config fields shared by every Transport selection.
 */
interface PluginConfigBase {
  enabled: boolean
  events: Record<NotificationKind, boolean>
  suppressSubagents: SuppressSubagentSettings
  /**
   * Grace period in milliseconds before a `permission.asked` notification is
   * published. A matching `permission.replied` within that window cancels the
   * pending notification. `0` publishes immediately without a grace period.
   */
  permissionNotificationDelayMs: number
  /**
   * Tool names whose `execute.before` calls are forwarded as `agent.notify`
   * notifications. These tools come from the user's own setup (an MCP server
   * or another plugin); opencode itself documents no built-in notify tool.
   */
  agentNotifyTools: string[]
  /**
   * When true, idle notifications carry the human session title and the last
   * assistant output (best-effort, deadline-bounded). The notification data
   * scope widens accordingly and is documented in the README.
   */
  enrichIdleMessages: boolean
}

export interface NtfyPluginConfig extends PluginConfigBase {
  transport: "ntfy"
  ntfy: NtfySettings
}

export interface GotifyPluginConfig extends PluginConfigBase {
  transport: "gotify"
  gotify: GotifySettings
}

export interface WebPushPluginConfig extends PluginConfigBase {
  transport: "webpush"
  webpush: WebPushSettings
}

/**
 * The validated plugin configuration: a discriminated union over the active
 * Transport. Exactly one Transport is active per instance and only its section
 * is present.
 */
export type PluginConfig = NtfyPluginConfig | GotifyPluginConfig | WebPushPluginConfig

/**
 * The native opencode v2 event envelope delivered on the public event stream.
 *
 * The stream is decoded from the SDK as unknown and narrowed manually in
 * event-adapter.ts: every field stays `unknown` so a malformed frame is
 * rejected instead of trusted. `data` carries the event-specific payload and
 * `location` identifies the server location the event originated from (the v2
 * stream is global across locations, so consumers must filter on it).
 */
export interface RuntimeEventEnvelope {
  id?: unknown
  type?: unknown
  data?: unknown
  location?: unknown
  created?: unknown
  durable?: unknown
}

/**
 * Ready-to-send notification. Title and message are bounded and sanitized by
 * the ntfy client right before publishing.
 */
export interface NotificationDraft {
  kind: NotificationKind
  title: string
  message: string
  tags: string[]
}

export const CONFIG_FILE_NAME = "notification-notifications-with-questions.json"

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh"
export const DEFAULT_NTFY_PRIORITY: NtfyPriority = "default"
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * Default grace period before a permission request is notified. Tuned so a fast
 * manual answer (and opencode's own auto-approval, which is invisible to
 * plugins) usually lands before the notification is sent.
 */
export const DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS = 15000
export const MAX_PERMISSION_NOTIFICATION_DELAY_MS = 300000

export const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/

export const MAX_CONFIG_FILE_BYTES = 64 * 1024
export const MAX_REFERENCED_FILE_BYTES = 16 * 1024

export const MAX_TITLE_BYTES = 1024
export const MAX_MESSAGE_BYTES = 4096

export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 60000

/**
 * Deadline for one fallback session.get classification lookup. OpenCode's SDK
 * promise cannot be cancelled, so this bounds how long an idle/error event
 * waits before the plugin fails open.
 */
export const DEFAULT_SESSION_LOOKUP_TIMEOUT_MS = 5000

/** Exact name of the built-in tool that asks the user questions. */
export const QUESTION_TOOL_NAME = "question"
