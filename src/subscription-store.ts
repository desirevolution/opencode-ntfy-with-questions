/**
 * Subscription Store: the JSON file the Bootstrap Service writes and the
 * webpush Adapter re-reads at publish time, so registrations take effect
 * without restarting opencode.
 *
 * Store format (shared with the Bootstrap Service, ticket 05): a JSON array
 * of Subscriptions in the browser's `PushSubscription.toJSON()` shape —
 *
 *   [
 *     {
 *       "endpoint": "https://push-service.example/send/<token>",
 *       "keys": { "p256dh": "<base64url>", "auth": "<base64url>" }
 *     }
 *   ]
 *
 * Extra fields on an entry are tolerated for forward compatibility. This is
 * the plugin's first non-startup-validated file by design: it is read fresh
 * per publish, malformed entries are skipped with a logged warning and a
 * broken store never crashes the publish path. Log lines never contain
 * endpoint URLs (they carry the subscription's secret token) or key material.
 */

import { open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"

import type { Logger } from "./types.js"

/** Receiver key material of one Subscription: a P-256 public key and an auth secret. */
export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

/** One Subscription: a browser-side registration identifying one device. */
export interface PushSubscriptionEntry {
  endpoint: string
  keys: PushSubscriptionKeys
}

export interface SubscriptionStoreDeps {
  log?: Logger
}

/** Upper bound for one store read; beyond it the store is treated as empty. */
export const MAX_SUBSCRIPTION_STORE_BYTES = 256 * 1024

/**
 * A store the Bootstrap Service's write path refuses to touch: unreadable,
 * oversized, unparsable or not an array. Unlike the publish-path read this
 * never degrades to an empty store, so a register or deregister can never
 * overwrite a store file it failed to see. Messages name the store path and a
 * short code; they never contain entry or endpoint values (the module never
 * logs them either).
 */
export class SubscriptionStoreReadError extends Error {
  constructor(
    /** Short failure code, e.g. "EACCES", "ETOOLARGE", "EPARSE". */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "SubscriptionStoreReadError"
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural validation of one store entry. The endpoint must be an https URL
 * (Web Push is browser-to-push-service over TLS); the two keys must be
 * non-empty strings. Crypto validity is not checked here: a junk key fails
 * isolated for that one Subscription at publish time.
 */
function isSubscriptionEntry(value: unknown): value is PushSubscriptionEntry {
  if (!isPlainObject(value)) return false
  const endpoint = value["endpoint"]
  if (typeof endpoint !== "string" || endpoint === "") return false
  try {
    if (new URL(endpoint).protocol !== "https:") return false
  } catch {
    return false
  }
  const keys = value["keys"]
  if (!isPlainObject(keys)) return false
  return (
    typeof keys["p256dh"] === "string" &&
    keys["p256dh"] !== "" &&
    typeof keys["auth"] === "string" &&
    keys["auth"] !== ""
  )
}

/**
 * Reads the store fresh and returns the well-formed Subscriptions. A missing,
 * unparsable, oversized or unreadable store yields an empty list with one
 * logged warning; malformed entries are skipped with a logged warning each.
 */
export async function readSubscriptions(storePath: string, deps: SubscriptionStoreDeps = {}): Promise<PushSubscriptionEntry[]> {
  const log = deps.log
  let text: string
  try {
    text = await readWithinLimit(storePath)
  } catch (cause) {
    if (cause instanceof StoreTooLargeError) {
      log?.(
        `webpush subscription store "${storePath}" exceeds the ${MAX_SUBSCRIPTION_STORE_BYTES}-byte limit; treating it as empty`,
      )
      return []
    }
    const code = cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "error"
    log?.(
      code === "ENOENT"
        ? `webpush subscription store "${storePath}" not found; no subscriptions are registered`
        : `webpush subscription store "${storePath}" could not be read (${code}); treating it as empty`,
    )
    return []
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    log?.(`webpush subscription store "${storePath}" is not valid JSON; treating it as empty`)
    return []
  }
  if (!Array.isArray(raw)) {
    log?.(`webpush subscription store "${storePath}" must contain a JSON array; treating it as empty`)
    return []
  }
  const entries: PushSubscriptionEntry[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const value = raw[i]
    if (isSubscriptionEntry(value)) {
      entries.push(value)
    } else {
      log?.(`webpush subscription store "${storePath}": entry ${i + 1} skipped (invalid shape)`)
    }
  }
  return entries
}

/**
 * Strict store read shared by the Bootstrap Service's write path and the
 * plugin's cleanup. Returns the raw array members (shape validation is the
 * caller's business, so foreign or forward-compatible entries survive
 * rewrites). A missing, unreadable, oversized, unparsable or non-array store
 * throws `SubscriptionStoreReadError` — including ENOENT, so callers can
 * tell a missing file from a genuinely empty one.
 */
async function readStoreArray(storePath: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readWithinLimit(storePath)
  } catch (cause) {
    if (cause instanceof StoreTooLargeError) {
      throw new SubscriptionStoreReadError(
        "ETOOLARGE",
        `subscription store "${storePath}" exceeds the ${MAX_SUBSCRIPTION_STORE_BYTES}-byte limit`,
      )
    }
    const code = cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "ERROR"
    throw new SubscriptionStoreReadError(code, `subscription store "${storePath}" could not be read (${code})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SubscriptionStoreReadError("EPARSE", `subscription store "${storePath}" is not valid JSON`)
  }
  if (!Array.isArray(raw)) {
    throw new SubscriptionStoreReadError("EPARSE", `subscription store "${storePath}" must contain a JSON array`)
  }
  return raw
}

/**
 * Strict variant of `readSubscriptions` for the Bootstrap Service's write
 * path. A missing store file is an empty list (that is how the first
 * registration starts); everything else — unreadable, oversized, unparsable
 * or not an array — throws `SubscriptionStoreReadError` so the service can
 * refuse the change instead of rewriting a store it failed to see.
 */
export async function loadSubscriptionStore(storePath: string): Promise<unknown[]> {
  try {
    return await readStoreArray(storePath)
  } catch (cause) {
    if (cause instanceof SubscriptionStoreReadError && cause.code === "ENOENT") return []
    throw cause
  }
}

/**
 * Store mutations are serialized within this process, mirroring the
 * Bootstrap Service's serialized queue: overlapping 410/404 cleanups each
 * read the store fresh and rewrite it atomically, so their read-modify-write
 * must not interleave (last-writer-wins would lose a removal). The queue
 * only chains promises — it never blocks the event loop, and the publish
 * fan-out runs outside it, so the publish deadline semantics are unchanged.
 * (This is in-process ordering; see the README caveat about the Bootstrap
 * Service writing from a separate process.)
 */
function serializeMutations(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

const enqueueMutation = serializeMutations()

/**
 * Removes the given endpoints from the store with an atomic write (temp file
 * plus rename, crash-safe). The store is read fresh first; when nothing needs
 * removal the file is left untouched, and every failure is logged and
 * swallowed so a cleanup can never crash the publish path.
 *
 * The rewrite works on the raw store array: it drops exactly the entries
 * whose endpoint is removed and keeps every other entry — including the
 * malformed ones the tolerant publish read skips — so a cleanup never
 * silently deletes data it did not understand.
 */
export async function removeSubscriptions(
  storePath: string,
  endpoints: ReadonlySet<string>,
  deps: SubscriptionStoreDeps = {},
): Promise<void> {
  if (endpoints.size === 0) return
  return enqueueMutation(async () => {
    let raw: unknown[]
    try {
      raw = await readStoreArray(storePath)
    } catch (cause) {
      const code = cause instanceof SubscriptionStoreReadError ? cause.code : "error"
      deps.log?.(
        code === "ENOENT"
          ? `webpush subscription store "${storePath}" not found; nothing to remove`
          : `webpush subscription store "${storePath}" could not be read (${code}); the expired Subscription stays listed`,
      )
      return
    }
    const kept = raw.filter((item) => {
      const endpoint = endpointOf(item)
      return endpoint === undefined || !endpoints.has(endpoint)
    })
    if (kept.length === raw.length) return
    try {
      await writeSubscriptionStore(storePath, kept)
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "error"
      deps.log?.(`webpush subscription store "${storePath}" could not be updated (${code}); the expired Subscription stays listed`)
    }
  })
}

/** The endpoint URL of a raw store item, if it has a string one. */
function endpointOf(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined
  const endpoint = item["endpoint"]
  return typeof endpoint === "string" ? endpoint : undefined
}

/**
 * Writes the store atomically: the JSON document goes to a temp file in the
 * same directory, is flushed, and then renamed over the store path so a
 * crash mid-write never leaves a half-written store behind. Shared by the
 * plugin's 410-Gone cleanup and the Bootstrap Service (same discipline, one
 * implementation, same file shape).
 */
export async function writeSubscriptionStore(storePath: string, entries: readonly unknown[]): Promise<void> {
  const tempPath = `${storePath}.tmp-${randomUUID()}`
  // 0600: the store holds push-endpoint URLs (which carry the subscription's
  // secret token) and key material. The rename preserves the mode; a
  // permissive umask must not widen the store or the temp file.
  const handle = await open(tempPath, "w", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(entries, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tempPath, storePath)
  } catch (cause) {
    // Never leave a temp file behind on a failed rename.
    await rm(tempPath, { force: true })
    throw cause
  }
}

/**
 * Reads a UTF-8 file without ever buffering more than the store limit: the
 * stat size is checked first, then at most `limit + 1` bytes are read so an
 * unexpected growth still triggers the limit instead of an unbounded buffer.
 */
async function readWithinLimit(storePath: string): Promise<string> {
  const handle = await open(storePath, "r")
  try {
    const stat = await handle.stat()
    if (stat.size > MAX_SUBSCRIPTION_STORE_BYTES) {
      throw new StoreTooLargeError()
    }
    const buffer = Buffer.alloc(MAX_SUBSCRIPTION_STORE_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_SUBSCRIPTION_STORE_BYTES) throw new StoreTooLargeError()
    return buffer.subarray(0, total).toString("utf8")
  } finally {
    await handle.close()
  }
}

class StoreTooLargeError extends Error {
  readonly code = "ETOOLARGE"

  constructor() {
    super("subscription store exceeds the size limit")
    this.name = "StoreTooLargeError"
  }
}
