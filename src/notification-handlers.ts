/**
 * Notification handlers shared by the opencode v2 plugin adapter.
 *
 * The core is deliberately runtime-agnostic: it takes a neutral `getSession`
 * lookup and exposes stable method names (`event`, `question`, `dispose`), so
 * the notification behavior can be tested without the SDK. Every path fails
 * open - an ntfy, formatter or logger failure must never reject a hook or block
 * the built-in question tool.
 */

import {
  formatAgentNotifyDraft,
  formatErrorDraft,
  formatIdleDraft,
  formatPermissionDraft,
  formatQuestionDraft,
  parseRuntimeEvent,
} from "./event-adapter.js"
import { describeNtfyError } from "./ntfy-client.js"
import { SessionRegistry } from "./session-registry.js"
import { openCodeWebTarget } from "./webui-link.js"
import type { TransportAdapter } from "./transport.js"
import { eventLocationDirectory } from "./v2-runtime.js"
import {
  DEFAULT_SESSION_CONTEXT_TIMEOUT_MS,
  DEFAULT_SESSION_LOOKUP_TIMEOUT_MS,
  QUESTION_TOOL_NAME,
  type Logger,
  type NotificationDraft,
  type PluginConfig,
} from "./types.js"

export type { Logger }

export function defaultLogger(message: string): void {
  console.warn(`[opencode-notifications-with-questions] ${message}`)
}

/**
 * Neutral session lookup result. `parentID` absent or empty means the session
 * is a root. opencode >= 2.2 additionally reports the session's owning
 * directory on the lookup result (nested `location.directory`, historically a
 * flat `directory`); location-less execution events need it for the ownership
 * check.
 */
export interface SessionLookupResult {
  parentID?: string | null
  location?: { directory?: string }
  directory?: string
  /** Human session title when the lookup result carries it (idle enrichment). */
  title?: string
}

/**
 * Neutral session classification derived from one shared lookup: the subagent
 * question (parent) and, when the result carries it, the owning directory for
 * location-less execution events. `directory` is undefined when the lookup
 * yielded none (failure, timeout or an older opencode).
 */
interface SessionInfo {
  child: boolean
  directory: string | undefined
}

export interface HandlerDeps {
  config: PluginConfig
  /** Display name for notifications: the basename of the project directory. */
  projectName: string
  /**
   * The plugin's own location directory. Location-less `session.execution.*`
   * events verify ownership by comparing the looked-up session directory
   * against this value.
   */
  directory: string
  /** Injectable clock so the idle de-duplication window tests stay deterministic. */
  now?: () => number
  /** Resolves one session directly; rejects on transport failure. */
  getSession: (sessionID: string) => Promise<SessionLookupResult>
  /**
   * Resolves the session's message list for the idle enrichment (the last
   * assistant output). Optional: without it the idle message stays generic.
   * The handler races it against sessionContextTimeoutMs.
   */
  getSessionContext?: (sessionID: string) => Promise<unknown>
  /** Deadline for one enrichment lookup. Tests inject small values. */
  sessionContextTimeoutMs?: number
  /** The active Transport's Adapter. Handlers never depend on a channel's client. */
  transport: TransportAdapter
  registry?: SessionRegistry
  log?: Logger
  /**
   * Deadline for one fallback session lookup classification. Defaults to
   * DEFAULT_SESSION_LOOKUP_TIMEOUT_MS; tests inject small values.
   */
  sessionLookupTimeoutMs?: number
}

/**
 * Normalizes the session lookup deadline: any positive finite integer is
 * accepted, anything else falls back to the production default.
 */
export function resolveSessionLookupTimeout(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return DEFAULT_SESSION_LOOKUP_TIMEOUT_MS
}

/**
 * Normalizes the enrichment deadline separately from the session lookup
 * deadline: enrichment defaults to a short 2 s so an idle push is never
 * meaningfully delayed.
 */
export function resolveSessionContextTimeout(value: number | undefined): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  return DEFAULT_SESSION_CONTEXT_TIMEOUT_MS
}

/** Window in which the second idle source of the same run is dropped. */
const IDLE_DEDUP_WINDOW_MS = 2000

/** Bound for the per-session idle de-duplication marks. */
const MAX_TRACKED_IDLE_SESSIONS = 512

export function extractSessionTitle(result: SessionLookupResult): string | undefined {
  const title = result.title
  return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined
}

/**
 * Best-effort extraction of the last assistant output of a session for the
 * idle enrichment. `ctx.session.context` resolves to the session's message
 * list; the newest assistant message's text parts are joined and returned so
 * the push shows what was actually done. Returns undefined when the context
 * has no assistant output or does not match the expected shape.
 */
export function extractLastAssistantText(context: unknown): string | undefined {
  const messages = Array.isArray(context) ? context : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue
    const record = message as Record<string, unknown>
    if (record["type"] !== "assistant") continue
    const content = Array.isArray(record["content"]) ? record["content"] : []
    const texts: string[] = []
    for (const part of content) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue
      const textPart = part as Record<string, unknown>
      if (textPart["type"] === "text" && typeof textPart["text"] === "string" && textPart["text"].trim() !== "") {
        texts.push(textPart["text"].trim())
      }
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return undefined
}

/**
 * Reads the owning directory from a session lookup result: opencode >= 2.2
 * reports `location.directory`, historically a flat `directory`. Returns
 * undefined when neither is present.
 */
export function extractSessionDirectory(result: SessionLookupResult): string | undefined {
  const location = result.location
  const nested = typeof location === "object" && location !== null ? location.directory : undefined
  if (typeof nested === "string" && nested !== "") return nested
  if (typeof result.directory === "string" && result.directory !== "") return result.directory
  return undefined
}

export interface PluginHandlers {
  event(input: { event: unknown }): Promise<void>
  question(tool: string, args: unknown, sessionID?: string): Promise<void>
  /**
   * Forwards a notify tool call from the `execute.before` hook as an
   * `agent.notify` notification, when the tool is listed in the configured
   * `agentNotifyTools`. Explicit requests are never suppressed or deduplicated.
   */
  notify(tool: string, args: unknown, sessionID?: string): Promise<void>
  /** Cancels every pending delayed permission notification. */
  dispose(): Promise<void>
}

/**
 * Upper bound on the recently-replied request ID memory. It only needs to
 * cover the narrow race where a reply is observed before its ask event.
 */
const MAX_RECENTLY_REPLIED_REQUEST_IDS = 512

/**
 * Concurrent ntfy publishes. Timer, question and event paths share this gate;
 * excess work is skipped instead of queued so a flood cannot grow unbounded.
 */
const MAX_CONCURRENT_PUBLISHES = 64

/** Pending permission timers (identified + anonymous) held at once. */
const MAX_PENDING_PERMISSION_TIMERS = 512

function asLookupResult(value: unknown): SessionLookupResult | undefined {
  return typeof value === "object" && value !== null ? (value as SessionLookupResult) : undefined
}

/**
 * Builds the notification handlers from explicit dependencies so tests can
 * drive every notification route with fakes.
 */
export function createPluginHandlers(deps: HandlerDeps): PluginHandlers {
  const registry = deps.registry ?? new SessionRegistry()
  const log = deps.log ?? defaultLogger
  const config = deps.config
  const projectName = deps.projectName
  const linkDraft = (draft: NotificationDraft, sessionID?: string): NotificationDraft => {
    if (config.transport !== "webpush") return draft
    const url = openCodeWebTarget(config.webpush, sessionID)
    return url ? { ...draft, url } : draft
  }
  const pluginDirectory = deps.directory
  const now = deps.now ?? Date.now
  const lookupTimeoutMs = resolveSessionLookupTimeout(deps.sessionLookupTimeoutMs)
  const contextTimeoutMs = resolveSessionContextTimeout(deps.sessionContextTimeoutMs)
  // Shared in-flight classifications: concurrent cache misses for the same
  // session coalesce into one session lookup.
  const pendingClassifications = new Map<string, Promise<SessionInfo>>()
  // De-duplication of the two idle sources: `session.execution.succeeded` is
  // the primary source (opencode >= 2.2) and `session.status` idle the
  // secondary fallback for older or TUI-driven contexts. Whichever source
  // publishes first marks the session; the other source arriving within the
  // window is dropped, so a single run never produces two notifications.
  const lastIdlePublishedAt = new Map<string, number>()

  const safeLog = (message: string): void => {
    // # Reason: an injected logger may throw; logging must never crash a timer,
    // a detached event dispatch or cleanup.
    try {
      log(message)
    } catch {
      // Swallow logger failures deliberately.
    }
  }

  // Once disposed, no hook may schedule, publish or start anything new.
  let disposed = false

  // Publish concurrency gate. Excess work is skipped with one fixed warning
  // until capacity frees up again.
  let inFlightPublishes = 0
  let publishOverflowWarned = false

  const send = async (draft: NotificationDraft): Promise<void> => {
    if (disposed) return
    if (inFlightPublishes >= MAX_CONCURRENT_PUBLISHES) {
      if (!publishOverflowWarned) {
        publishOverflowWarned = true
        safeLog(`notification "${draft.kind}" skipped: too many concurrent notifications`)
      }
      return
    }
    inFlightPublishes += 1
    try {
      // # Reason: disposed can flip during a preceding await (for example a
      // session classification); re-check immediately before the irreversible
      // HTTP publish so no new publish starts after cleanup.
      if (disposed) return
      await deps.transport.publish(draft)
    } catch (error) {
      safeLog(`notification "${draft.kind}" was not sent: ${deps.transport.describeError(error)}`)
    } finally {
      inFlightPublishes -= 1
      if (inFlightPublishes < MAX_CONCURRENT_PUBLISHES) publishOverflowWarned = false
    }
  }

  const permissionNotificationDelayMs = config.permissionNotificationDelayMs
  // Pending delayed permission notifications, keyed by request ID. Requests
  // without a usable ID are tracked separately only so dispose can clear them.
  const permissionRequestTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const anonymousPermissionTimers = new Set<ReturnType<typeof setTimeout>>()
  // Bounded FIFO of request IDs answered recently, so a permission.replied that
  // is observed before its permission.asked still suppresses the notification.
  const recentlyRepliedRequestIDs = new Set<string>()
  let permissionOverflowWarned = false

  const pendingPermissionTimerCount = (): number =>
    permissionRequestTimers.size + anonymousPermissionTimers.size

  /** Allows the overflow warning to fire again once capacity has room. */
  const notePermissionCapacityFreed = (): void => {
    if (pendingPermissionTimerCount() < MAX_PENDING_PERMISSION_TIMERS) permissionOverflowWarned = false
  }

  const rememberRepliedRequestID = (requestID: string): void => {
    // Re-insertion moves the ID to the most-recent position of the Set.
    if (recentlyRepliedRequestIDs.has(requestID)) recentlyRepliedRequestIDs.delete(requestID)
    recentlyRepliedRequestIDs.add(requestID)
    if (recentlyRepliedRequestIDs.size > MAX_RECENTLY_REPLIED_REQUEST_IDS) {
      const oldest = recentlyRepliedRequestIDs.values().next().value
      if (oldest !== undefined) recentlyRepliedRequestIDs.delete(oldest)
    }
  }

  /**
   * Schedules one delayed permission notification. A duplicate ask is ignored
   * while a notification for the same request ID is still pending, and while
   * that ID is still in the bounded recently-replied set. New pending requests
   * are dropped safely once the pending-timer cap is reached; replies are
   * always handled regardless.
   */
  const schedulePermissionNotification = (
    requestID: string | undefined,
    permission: string,
    patterns: string[],
    sessionID: string | undefined,
  ): void => {
    if (disposed) return
    if (requestID !== undefined && (permissionRequestTimers.has(requestID) || recentlyRepliedRequestIDs.has(requestID))) {
      return
    }
    if (pendingPermissionTimerCount() >= MAX_PENDING_PERMISSION_TIMERS) {
      if (!permissionOverflowWarned) {
        permissionOverflowWarned = true
        safeLog("permission notification skipped: too many pending permission notifications")
      }
      return
    }
    const timer = setTimeout(() => {
      if (requestID !== undefined) permissionRequestTimers.delete(requestID)
      else anonymousPermissionTimers.delete(timer)
      notePermissionCapacityFreed()
      if (disposed) return
      // The timer boundary must never surface an unhandled rejection or throw,
      // even if publish rejects and the injected logger throws while reporting
      // it. Formatting failures are swallowed for the same reason.
      try {
        void send(linkDraft(formatPermissionDraft(permission, patterns, sessionID, projectName), sessionID)).catch(() => {})
      } catch {
        // A formatting failure must not become an uncaught timer exception.
      }
    }, permissionNotificationDelayMs)
    // Never keep the process alive just for a pending notification.
    timer.unref?.()
    if (requestID !== undefined) permissionRequestTimers.set(requestID, timer)
    else anonymousPermissionTimers.add(timer)
  }

  /** Cancels a pending notification for an answered request and remembers the reply. */
  const handlePermissionReplied = (requestID: string): void => {
    const timer = permissionRequestTimers.get(requestID)
    if (timer !== undefined) {
      clearTimeout(timer)
      permissionRequestTimers.delete(requestID)
      notePermissionCapacityFreed()
    }
    rememberRepliedRequestID(requestID)
  }

  const dispose = async (): Promise<void> => {
    // Mark first so a hook invoked during or after disposal cannot reschedule.
    disposed = true
    for (const timer of permissionRequestTimers.values()) clearTimeout(timer)
    permissionRequestTimers.clear()
    for (const timer of anonymousPermissionTimers) clearTimeout(timer)
    anonymousPermissionTimers.clear()
    recentlyRepliedRequestIDs.clear()
    pendingClassifications.clear()
    lastIdlePublishedAt.clear()
    registry.clear()
  }

  /**
   * Races one session lookup against the lookup deadline. A timeout is treated
   * exactly like a lookup failure (undefined result); the underlying SDK
   * promise is never cancelled and may settle later, which Promise.race
   * absorbs so it can have no effect and no unhandled rejection.
   */
  const raceSessionLookup = async (sessionID: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session lookup deadline exceeded")), lookupTimeoutMs)
    })
    try {
      try {
        return await Promise.race([deps.getSession(sessionID), deadline])
      } catch {
        return undefined
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Performs one tracked fallback classification for a session. The lookup is
   * revision-tracked so a lifecycle event (for example session.deleted) that
   * lands while the request is in flight invalidates the stale response.
   */
  const classifySession = async (sessionID: string): Promise<SessionInfo> => {
    const revision = registry.beginLookup(sessionID)
    try {
      const result = await raceSessionLookup(sessionID)

      // A lifecycle classification recorded while the lookup was in flight is
      // fresher than the response and always wins. The lifecycle payload
      // carries no directory, so ownership stays unverifiable here and fails
      // open at the caller.
      const refreshed = registry.parentOf(sessionID)
      if (refreshed !== undefined) return { child: refreshed !== null, directory: undefined }

      // The lookup was invalidated (session deleted/cleared): the response
      // describes a stale session, so it is discarded and never cached.
      if (!registry.lookupIsCurrent(sessionID, revision)) {
        safeLog(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return { child: false, directory: undefined }
      }

      // No usable response (transport failure, timeout or invalid result):
      // fail open without guessing a classification.
      const usable = asLookupResult(result)
      if (!usable) {
        safeLog(`could not classify session "${sessionID}" (lookup failed); sending the notification anyway`)
        return { child: false, directory: undefined }
      }

      // Native `session.get` resolves directly to the session info, so the
      // parent ID and the owning directory are read straight off the response.
      const rawParent = usable.parentID
      const parent = typeof rawParent === "string" && rawParent !== "" ? rawParent : null
      registry.record(sessionID, parent, extractSessionDirectory(usable), extractSessionTitle(usable))
      return { child: parent !== null, directory: extractSessionDirectory(usable) }
    } finally {
      registry.endLookup(sessionID)
    }
  }

  /**
   * Resolves the shared classification for a session. Concurrent callers for
   * the same session coalesce into one lookup, and the result serves both the
   * subagent question and the ownership question for location-less execution
   * events.
   */
  const ensureSessionInfo = (sessionID: string): Promise<SessionInfo> => {
    const pending = pendingClassifications.get(sessionID)
    if (pending !== undefined) return pending

    const classification = classifySession(sessionID)
    pendingClassifications.set(sessionID, classification)
    // Release the shared entry once it settles, but only while it is still the
    // entry for this session (a newer classification may have replaced it).
    const release = (): void => {
      if (pendingClassifications.get(sessionID) === classification) pendingClassifications.delete(sessionID)
    }
    void classification.then(release, release)
    return classification
  }

  const typeOf = (raw: unknown): string => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ""
    const type = (raw as { type?: unknown })["type"]
    return typeof type === "string" ? type : ""
  }

  /**
   * Ownership verification applies only to `session.execution.*` frames that
   * arrive without a location (opencode >= 2.2). Everything else reached the
   * runtime's strict location gate already.
   */
  const requiresOwnership = (raw: unknown): boolean =>
    typeOf(raw).startsWith("session.execution.") && eventLocationDirectory(raw) === undefined

  /**
   * Verifies that a location-less execution event belongs to this plugin
   * instance by comparing the looked-up session directory against the plugin
   * directory, and answers the subagent question from the same classification.
   * Returns false only when the notification must be dropped: a session-owned
   * directory that is not ours (multi-project machines), or a known subagent
   * under suppression. Failures fail open: a lookup that yields no directory
   * (older opencode, unusable lookup) notifies anyway without extra noise -
   * the classification already logged its own warning on real failures.
   * Lifecycle-cached sessions carry no directory by construction - their
   * lifecycle events were local, so failing open stays correct for them.
   */
  const sessionGate = async (
    parsed: { kind: "session.idle" | "session.error"; sessionID?: string },
    raw: unknown,
  ): Promise<boolean> => {
    const ownership = requiresOwnership(raw)
    const suppress =
      parsed.sessionID !== undefined && config.suppressSubagents[parsed.kind === "session.idle" ? "session.idle" : "session.error"]
    if (!ownership && !suppress) return true
    if (parsed.sessionID === undefined) return true

    const cachedParent = registry.parentOf(parsed.sessionID)
    if (cachedParent !== undefined) {
      if (suppress && cachedParent !== null) return false
      if (ownership) {
        const cachedDirectory = registry.directoryOf(parsed.sessionID)
        if (cachedDirectory !== undefined && cachedDirectory !== pluginDirectory) return false
        // Lifecycle-cached without a directory: the lifecycle event was local,
        // so the session is ours; fail open silently.
      }
      return true
    }

    const info = await ensureSessionInfo(parsed.sessionID)
    if (suppress && info.child) return false
    if (ownership && info.directory !== undefined && info.directory !== pluginDirectory) return false
    // An unknown directory fails open silently; the classification logged its
    // own warning when the lookup genuinely failed.
    return true
  }

  /** Records an idle publish attempt and keeps the mark map bounded. */
  const markIdlePublished = (sessionID: string, timestamp: number): void => {
    lastIdlePublishedAt.set(sessionID, timestamp)
    while (lastIdlePublishedAt.size > MAX_TRACKED_IDLE_SESSIONS) {
      const oldest = lastIdlePublishedAt.keys().next()
      if (oldest.done === true) break
      lastIdlePublishedAt.delete(oldest.value)
    }
  }

  /**
   * Resolves the session's last assistant output for the idle enrichment,
   * raced against a short deadline so a hanging context call can never delay
   * the idle publish meaningfully. Failures return undefined (generic
   * message), never an error.
   */
  const raceLastMessage = async (sessionID: string): Promise<string | undefined> => {
    if (deps.getSessionContext === undefined) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session context deadline exceeded")), contextTimeoutMs)
    })
    try {
      try {
        return extractLastAssistantText(await Promise.race([deps.getSessionContext(sessionID), deadline]))
      } catch {
        return undefined
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const onEvent = async (input: { event: unknown }): Promise<void> => {
    if (disposed) return
    try {
      const parsed = parseRuntimeEvent(input?.event)
      if (!parsed) return
      switch (parsed.kind) {
        case "lifecycle":
          // # Reason: lifecycle mutations run synchronously, before any await,
          // so a slow idle/error classification can never delay them.
          if (parsed.action === "deleted") registry.remove(parsed.sessionID)
          else registry.record(parsed.sessionID, parsed.parentID)
          return
        case "session.idle": {
          if (!config.events["session.idle"]) return
          // The secondary idle source (`session.status`) is dropped while the
          // primary source (`session.execution.succeeded`) published for the
          // same session within the window, so one run never notifies twice.
          if (parsed.source === "status") {
            const last = lastIdlePublishedAt.get(parsed.sessionID)
            if (last !== undefined && now() - last < IDLE_DEDUP_WINDOW_MS) return
          }
          // Ownership for location-less execution frames and subagent
          // suppression share one coalesced session lookup.
          if (!(await sessionGate(parsed, input.event))) return
          // Cleanup may have happened while the classification was in flight.
          if (disposed) return
          const title = config.enrichIdleMessages ? registry.titleOf(parsed.sessionID) : undefined
          const lastMessage = config.enrichIdleMessages ? await raceLastMessage(parsed.sessionID) : undefined
          await send(linkDraft(formatIdleDraft(parsed.sessionID, projectName, { title, lastMessage }), parsed.sessionID))
          if (parsed.source === "execution") markIdlePublished(parsed.sessionID, now())
          return
        }
        case "session.error": {
          if (!config.events["session.error"]) return
          // An error without a sessionID cannot be classified and always notifies.
          if (!(await sessionGate(parsed, input.event))) return
          if (disposed) return
          await send(linkDraft(formatErrorDraft(parsed.sessionID, parsed.errorMessage, projectName), parsed.sessionID))
          return
        }
        case "permission.asked": {
          // Permission notifications cover root and child sessions alike, but a
          // disposed handler must not schedule or publish anything.
          if (disposed) return
          if (!config.events["permission.asked"]) return
          if (permissionNotificationDelayMs > 0) {
            // Positive grace period: schedule and return without waiting for ntfy.
            schedulePermissionNotification(parsed.requestID, parsed.permission, parsed.patterns, parsed.sessionID)
            return
          }
          // Delay 0 keeps the original behavior: publish before returning.
          await send(linkDraft(formatPermissionDraft(parsed.permission, parsed.patterns, parsed.sessionID, projectName), parsed.sessionID))
          return
        }
        case "permission.replied": {
          // With no grace period there is never a pending notification to cancel.
          if (permissionNotificationDelayMs <= 0) return
          // # Reason: cancellation is synchronous so a pending permission
          // notification is retracted immediately, before any other await.
          handlePermissionReplied(parsed.requestID)
          return
        }
      }
    } catch (error) {
      safeLog(`event handling failed: ${describeNtfyError(error)}`)
    }
  }

  const onQuestion = async (tool: string, args: unknown, sessionID?: string): Promise<void> => {
    if (disposed) return
    try {
      if (!config.events["question.asked"]) return
      // Notify only for the exact built-in tool name. The runtime question/form
      // events are deliberately ignored by parseRuntimeEvent to avoid duplicates.
      if (typeof tool !== "string" || tool !== QUESTION_TOOL_NAME) return
      await send(linkDraft(formatQuestionDraft(args, projectName), sessionID))
    } catch (error) {
      // A question notification must never prevent the tool from executing, even
      // if formatting or the logger fails.
      safeLog(`question notification failed: ${describeNtfyError(error)}`)
    }
  }

  const onNotify = async (tool: string, args: unknown, sessionID?: string): Promise<void> => {
    if (disposed) return
    try {
      if (!config.events["agent.notify"]) return
      // Forward only the configured notify tool names. Explicit agent requests
      // are never suppressed, classified or deduplicated.
      if (!config.agentNotifyTools.includes(tool)) return
      await send(linkDraft(formatAgentNotifyDraft(args, projectName), sessionID))
    } catch (error) {
      safeLog(`notify handling failed: ${describeNtfyError(error)}`)
    }
  }

  return { event: onEvent, question: onQuestion, notify: onNotify, dispose }
}
