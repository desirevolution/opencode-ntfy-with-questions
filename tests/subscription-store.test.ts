import { mkdir, readdir, readFile, rm, mkdtemp, stat, writeFile, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { readSubscriptions, removeSubscriptions, writeSubscriptionStore } from "../src/subscription-store.js"

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-store-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function logSink(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = []
  return { lines, log: (message) => lines.push(message) }
}

/**
 * Store-level fixtures only need structurally valid Subscriptions; the
 * adapter isolates crypto-level failures per Subscription. Values here are
 * deliberately not real base64url keys.
 */
function entryJson(i: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: `https://push.example.com/send/${i}`,
    keys: { p256dh: `p256dh-value-${i}`, auth: `auth-value-${i}` },
    ...overrides,
  }
}

async function writeStore(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

describe("readSubscriptions", () => {
  it("returns no subscriptions and logs when the store file does not exist", async () => {
    const dir = await makeDir()
    const { lines, log } = logSink()
    const entries = await readSubscriptions(join(dir, "missing.json"), { log })
    expect(entries).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("subscription store")
    expect(lines[0]).toContain("missing.json")
  })

  it("parses a valid store array into Subscriptions", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), entryJson(2)])
    const { log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([entryJson(1), entryJson(2)])
    expect(log).toBeDefined()
  })

  it("reads the store fresh on every call", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    const { log } = logSink()
    await writeStore(path, [entryJson(1)])
    expect(await readSubscriptions(path, { log })).toHaveLength(1)
    // A device registers between two publishes: the next publish sees it.
    await writeStore(path, [entryJson(1), entryJson(2)])
    expect(await readSubscriptions(path, { log })).toHaveLength(2)
  })

  it("skips malformed entries with a logged warning and keeps the valid ones", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [
      entryJson(1),
      "not-an-object",
      entryJson(3, { endpoint: "http://insecure.example.com/send/3" }),
      entryJson(4, { keys: { p256dh: "only-p256dh" } }),
      entryJson(5, { endpoint: 42 }),
      entryJson(6, { keys: "nope" }),
    ])
    const { lines, log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([entryJson(1)])
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      expect(line).toContain("subscription store")
      expect(line).toContain("skipped")
      // Endpoint URLs carry the subscription's secret token; key material is
      // secret too. Neither may appear in a log line.
      expect(line).not.toContain("push.example.com")
      expect(line).not.toContain("p256dh-value")
      expect(line).not.toContain("auth-value")
    }
  })

  it("treats a store whose root is not an array as empty with a warning", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, { endpoint: "https://push.example.com/send/1" })
    const { lines, log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("JSON array")
  })

  it("treats an unparsable store file as empty with a warning", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeFile(path, "{not json", "utf8")
    const { lines, log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("not valid JSON")
  })

  it("treats an unreadable store path as empty with a warning", async () => {
    const dir = await makeDir()
    // A directory at the store path: reads fail, publishes must not crash.
    const path = join(dir, "subscriptions.json")
    await mkdir(path)
    const { lines, log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("subscription store")
  })

  it("tolerates extra fields on entries for forward compatibility", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1, { registeredAt: "2026-11-15T00:00:00Z" })])
    const { log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([entryJson(1, { registeredAt: "2026-11-15T00:00:00Z" })])
  })

  it("treats a store beyond the size limit as empty with a warning", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    const filler = "x".repeat(300 * 1024)
    await writeFile(path, `["${filler}"]`, "utf8")
    const { lines, log } = logSink()
    const entries = await readSubscriptions(path, { log })
    expect(entries).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("limit")
    expect(lines[0]).not.toContain("xxxxx")
  })
})

describe("writeSubscriptionStore", () => {
  it("writes the store file owner-only (0600) regardless of umask", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    // The store holds push-endpoint URLs (secret tokens) and key material:
    // only the owning user may read or write it. A permissive umask would
    // mask a default-mode write, so the umask is narrowed to a value under
    // which 0666 and 0600 are distinguishable. Each test file runs in its
    // own forked process; the previous umask is restored afterwards.
    const previousUmask = process.umask(0o027)
    try {
      await writeSubscriptionStore(path, [entryJson(1)])
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      process.umask(previousUmask)
    }
  })
})

describe("removeSubscriptions", () => {
  it("removes the given endpoint with an atomic write and keeps the other entries", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), entryJson(2)])
    const { lines, log } = logSink()
    await removeSubscriptions(path, new Set([`https://push.example.com/send/2`]), { log })
    const stored = JSON.parse(await readFile(path, "utf8")) as unknown[]
    expect(stored).toEqual([entryJson(1)])
    // Crash-safe write: temp file written and renamed, nothing left behind.
    expect(await readdir(dir)).toEqual(["subscriptions.json"])
    expect(lines).toEqual([])
  })

  it("removes several endpoints in one write", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), entryJson(2), entryJson(3)])
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`, `https://push.example.com/send/3`]))
    const stored = JSON.parse(await readFile(path, "utf8")) as unknown[]
    expect(stored).toEqual([entryJson(2)])
  })

  it("leaves the store untouched when the endpoint is absent", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    const original = `${JSON.stringify([entryJson(1)], null, 2)}\n`
    await writeFile(path, original, "utf8")
    await removeSubscriptions(path, new Set([`https://push.example.com/gone`]))
    expect(await readFile(path, "utf8")).toBe(original)
    expect(await readdir(dir)).toEqual(["subscriptions.json"])
  })

  it("does nothing when the store file does not exist", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`]))
    expect(await readdir(dir)).toEqual([])
  })

  it("writes a hand-editable JSON array with a trailing newline", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), entryJson(2)])
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`]))
    const text = await readFile(path, "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(JSON.parse(text)).toEqual([entryJson(2)])
  })

  it("reports nothing to do for an empty endpoint set", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1)])
    await removeSubscriptions(path, new Set())
    const stored = JSON.parse(await readFile(path, "utf8")) as unknown[]
    expect(stored).toEqual([entryJson(1)])
  })

  it("keeps working when the store directory disappeared since the read", async () => {
    const dir = await makeDir()
    const subdir = join(dir, "state")
    await mkdir(subdir)
    const path = join(subdir, "subscriptions.json")
    await writeStore(path, [entryJson(1)])
    // The store existed at read time; the write target is gone now. The
    // removal must log and swallow instead of crashing the publish path.
    await rename(subdir, join(dir, "moved-away"))
    const { lines, log } = logSink()
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`]), { log })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("subscription store")
    expect(lines[0]).not.toContain("push.example.com")
  })

  it("removes an endpoint that re-appeared as malformed elsewhere in the file", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), "garbage-entry"])
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`]))
    const stored = JSON.parse(await readFile(path, "utf8")) as unknown[]
    // The cleanup rewrite drops exactly the removed endpoints; the malformed
    // entry carries no removable endpoint and must survive the rewrite.
    expect(stored).toEqual(["garbage-entry"])
  })

  it("keeps a malformed entry byte-faithfully when a well-formed entry is removed", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    const malformed = { endpoint: 42, keys: { p256dh: "kept-malformed" }, note: "hand-edited forward-compat entry" }
    await writeStore(path, [entryJson(1), malformed])
    await removeSubscriptions(path, new Set([`https://push.example.com/send/1`]))
    const text = await readFile(path, "utf8")
    const stored = JSON.parse(text) as unknown[]
    // The skipped entry is not silently deleted by a cleanup: it survives
    // the rewrite with its exact content and property order.
    expect(stored).toEqual([malformed])
    expect(text).toContain('"kept-malformed"')
    expect(text).toContain('"hand-edited forward-compat entry"')
  })

  it("serializes overlapping cleanups so concurrent removals are not lost", async () => {
    const dir = await makeDir()
    const path = join(dir, "subscriptions.json")
    await writeStore(path, [entryJson(1), entryJson(2), entryJson(3)])
    // Two overlapping publishes each clean up one expired endpoint. Without
    // serialization the read-modify-write steps interleave and the second
    // rewrite resurrects the first removal.
    await Promise.all([
      removeSubscriptions(path, new Set([`https://push.example.com/send/2`])),
      removeSubscriptions(path, new Set([`https://push.example.com/send/3`])),
    ])
    const stored = JSON.parse(await readFile(path, "utf8")) as unknown[]
    expect(stored).toEqual([entryJson(1)])
  })
})
