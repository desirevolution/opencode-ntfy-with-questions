import { createECDH, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { parseBootstrapArgs, runBootstrapCli, startBootstrapService, type BootstrapServiceHandle, type BootstrapServiceOptions } from "../src/bootstrap-service.js"

const tempDirs: string[] = []
const running: BootstrapServiceHandle[] = []

afterEach(async () => {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function logSink(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = []
  return { lines, log: (message) => lines.push(message) }
}

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A 65-byte uncompressed P-256 public key in canonical base64url, as web-push's generateVAPIDKeys() produces. */
function makeVapidPublicKey(): string {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return ecdh.getPublicKey("base64url")
}

/** One browser-side Subscription as PushSubscription.toJSON() would send it. */
function makeSubscription(origin: string, i: number): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    endpoint: `${origin}/send/${i}-${randomBytes(8).toString("hex")}`,
    keys: { p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") },
  }
}

interface StartedService {
  handle: BootstrapServiceHandle
  dir: string
  storePath: string
  origin: string
  lines: string[]
}

async function startService(overrides: Partial<BootstrapServiceOptions> = {}): Promise<StartedService> {
  const dir = await makeDir("ntfy-bootstrap-")
  const storePath = overrides.storePath ?? join(dir, "subscriptions.json")
  const sink = logSink()
  const handle = await startBootstrapService({
    storePath,
    vapidPublicKey: makeVapidPublicKey(),
    host: "127.0.0.1",
    port: 0,
    log: sink.log,
    ...overrides,
  })
  running.push(handle)
  return { handle, dir, storePath, origin: `http://127.0.0.1:${handle.port}`, lines: sink.lines }
}

async function readStore(storePath: string): Promise<{ text: string; parsed: unknown }> {
  const text = await readFile(storePath, "utf8")
  return { text, parsed: JSON.parse(text) as unknown }
}

describe("serving the page and the push service worker", () => {
  it("serves the register/deregister page with the served public VAPID key at GET /", async () => {
    const publicKey = makeVapidPublicKey()
    const service = await startService({ vapidPublicKey: publicKey })
    const res = await fetch(`${service.origin}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await res.text()
    expect(html).toContain(publicKey)
    expect(html).toContain('id="register"')
    expect(html).toContain('id="deregister"')
  })

  it("serves the push service worker that shows received pushes as visible notifications", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/service-worker.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    const js = await res.text()
    expect(js).toContain('addEventListener("push"')
    expect(js).toContain("showNotification")
  })
})

describe("register flow", () => {
  it("appends a well-formed subscription to the store on POST /register", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 1)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "registered" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([subscription])
  })

  it("writes the store exactly in the shared Subscription Store shape: a JSON array with trailing newline", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 1)
    await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    })
    const { text, parsed } = await readStore(service.storePath)
    expect(text.endsWith("\n")).toBe(true)
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as Array<typeof subscription>)[0]).toEqual(subscription)
    // Atomic temp+rename leaves no temp files behind.
    expect(await readdir(service.dir)).toEqual(["subscriptions.json"])
  })
})

describe("register accepts the real browser PushSubscription.toJSON() shape", () => {
  it("accepts expirationTime: null and stores the entry as {endpoint, keys}", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 1)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...subscription, expirationTime: null }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "registered" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([subscription])
  })

  it("accepts a numeric expirationTime and normalizes it away", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 2)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...subscription, expirationTime: 1730000000000 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "registered" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([subscription])
  })

  it.each([
    ["expirationTime not null or a number", JSON.stringify({ ...makeSubscription("https://push.example.com", 3), expirationTime: "soon" })],
    ["expirationTime not an integer", JSON.stringify({ ...makeSubscription("https://push.example.com", 4), expirationTime: 1.5 })],
    ["expirationTime negative", JSON.stringify({ ...makeSubscription("https://push.example.com", 5), expirationTime: -1 })],
  ])("rejects %s with the field-name error and leaves the store untouched", async (_name, body) => {
    const service = await startService()
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: boolean; error: string }
    expect(json.ok).toBe(false)
    expect(json.error).toBe(
      "expected a JSON object with the fields endpoint and keys, and an optional expirationTime (null or epoch milliseconds)",
    )
    await expect(readFile(service.storePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("duplicate registrations are idempotent", () => {
  it("answers unchanged for a duplicate with identical keys and never stores it twice", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 1)
    const first = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    })
    expect(await first.json()).toEqual({ ok: true, result: "registered" })
    const before = await readFile(service.storePath, "utf8")
    const second = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription),
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true, result: "unchanged" })
    expect(await readFile(service.storePath, "utf8")).toBe(before)
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([subscription])
  })

  it("replaces in place (never duplicates) when the same endpoint returns fresh keys", async () => {
    const service = await startService()
    const first = makeSubscription("https://push.example.com", 1)
    await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(first),
    })
    const second = { endpoint: first.endpoint, keys: makeSubscription("https://push.example.com", 2).keys }
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(second),
    })
    expect(await res.json()).toEqual({ ok: true, result: "replaced" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([second])
  })

  it("appends different endpoints and keeps existing entries untouched", async () => {
    const service = await startService()
    const existing = [{ endpoint: "https://push.example.com/seeded", keys: makeSubscription("https://push.example.com", 9).keys, note: "registered earlier" }]
    await writeFile(service.storePath, `${JSON.stringify(existing, null, 2)}\n`, "utf8")
    const fresh = makeSubscription("https://push.example.com", 1)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fresh),
    })
    expect(await res.json()).toEqual({ ok: true, result: "registered" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([...existing, fresh])
  })

  it("serializes concurrent registrations so no entry is lost", async () => {
    const service = await startService()
    const subscriptions = [1, 2, 3, 4].map((i) => makeSubscription("https://push.example.com", i))
    const answers = await Promise.all(
      subscriptions.map((subscription) =>
        fetch(`${service.origin}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subscription),
        }),
      ),
    )
    for (const answer of answers) {
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({ ok: true, result: "registered" })
    }
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual(subscriptions)
  })
})

describe("malformed register posts are rejected without touching the store", () => {
  /** One shared valid subscription; each case mutates or replaces its body. */
  function validBody(): Record<string, unknown> {
    return makeSubscription("https://push.example.com", 1) as unknown as Record<string, unknown>
  }

  const p256dhEcdh = createECDH("prime256v1")
  p256dhEcdh.generateKeys()
  const p256dhOf65Bytes = p256dhEcdh.getPublicKey("base64url")
  const authOf16Bytes = randomBytes(16).toString("base64url")

  it.each([
    ["empty body", ""],
    ["invalid JSON", "{oops"],
    ["non-object body", "[1, 2, 3]"],
    ["missing keys", JSON.stringify({ endpoint: "https://push.example.com/send/1" })],
    ["keys not an object", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: "nope" })],
    ["unknown top-level field", JSON.stringify({ ...validBody(), extra: true })],
    ["unknown keys field", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: { p256dh: p256dhOf65Bytes, auth: authOf16Bytes, extra: "x" } })],
    ["http endpoint", JSON.stringify({ endpoint: "http://push.example.com/send/1", keys: { p256dh: p256dhOf65Bytes, auth: authOf16Bytes } })],
    ["endpoint not a URL", JSON.stringify({ endpoint: "not a url", keys: { p256dh: p256dhOf65Bytes, auth: authOf16Bytes } })],
    ["p256dh wrong length", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: { p256dh: randomBytes(64).toString("base64url"), auth: authOf16Bytes } })],
    ["p256dh not an uncompressed point", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: { p256dh: Buffer.concat([Buffer.from([0x03]), randomBytes(64)]).toString("base64url"), auth: authOf16Bytes } })],
    ["p256dh not canonical base64url", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: { p256dh: `${p256dhOf65Bytes.slice(0, -2)}+/`, auth: authOf16Bytes } })],
    ["auth wrong length", JSON.stringify({ endpoint: "https://push.example.com/send/1", keys: { p256dh: p256dhOf65Bytes, auth: randomBytes(15).toString("base64url") } })],
  ])("rejects %s with 400 and leaves the store absent", async (_name, body) => {
    const service = await startService()
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: boolean; error: string }
    expect(json.ok).toBe(false)
    expect(typeof json.error).toBe("string")
    expect(json.error.length).toBeGreaterThan(0)
    // Nothing was written: the store file does not even exist.
    await expect(readFile(service.storePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a wrong content-type with 415", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(415)
  })

  it("rejects an oversized body with 413", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"endpoint":"https://push.example.com/x","pad":"${"x".repeat(9000)}"}`,
    })
    expect(res.status).toBe(413)
  })

  it("never echoes endpoints or key material in error responses or logs", async () => {
    const service = await startService()
    const subscription = makeSubscription("https://push.example.com", 1)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...subscription, endpoint: "http://insecure.example.com/secret-token" }),
    })
    expect(res.status).toBe(400)
    const responseText = await res.text()
    expect(responseText).not.toContain("insecure.example.com")
    expect(responseText).not.toContain("secret-token")
    expect(responseText).not.toContain(subscription.keys.p256dh)
    expect(responseText).not.toContain(subscription.keys.auth)
    for (const line of service.lines) {
      expect(line).not.toContain("insecure.example.com")
      expect(line).not.toContain("secret-token")
      expect(line).not.toContain(subscription.keys.p256dh)
    }
  })
})

describe("deregister flow", () => {
  it("removes the posted endpoint and preserves every other entry verbatim", async () => {
    const service = await startService()
    const first = makeSubscription("https://push.example.com", 1)
    const second = makeSubscription("https://push.example.com", 2)
    const junk = { whatever: "forward-compatible junk row" }
    await writeFile(service.storePath, `${JSON.stringify([first, junk, second], null, 2)}\n`, "utf8")
    const res = await fetch(`${service.origin}/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: first.endpoint }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "removed" })
    const { parsed } = await readStore(service.storePath)
    expect(parsed).toEqual([junk, second])
  })

  it("answers absent for an unknown endpoint and leaves the store file untouched", async () => {
    const service = await startService()
    const kept = makeSubscription("https://push.example.com", 1)
    await writeFile(service.storePath, `${JSON.stringify([kept], null, 2)}\n`, "utf8")
    const before = await readFile(service.storePath, "utf8")
    const res = await fetch(`${service.origin}/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/unknown" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "absent" })
    expect(await readFile(service.storePath, "utf8")).toBe(before)
  })

  it("answers absent without creating a store file when none exists", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/unknown" }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: "absent" })
    await expect(readFile(service.storePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects malformed deregister bodies with 400", async () => {
    const service = await startService()
    const kept = makeSubscription("https://push.example.com", 1)
    await writeFile(service.storePath, `${JSON.stringify([kept], null, 2)}\n`, "utf8")
    const before = await readFile(service.storePath, "utf8")
    for (const body of ["", "{oops", "null", "{}", JSON.stringify({ endpoint: "http://insecure.example.com/x" }), JSON.stringify({ endpoint: kept.endpoint, extra: true }), JSON.stringify({ keys: kept.keys })]) {
      const res = await fetch(`${service.origin}/deregister`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      expect(res.status).toBe(400)
    }
    expect(await readFile(service.storePath, "utf8")).toBe(before)
  })
})

describe("a store the service fails to see is never overwritten", () => {
  it("refuses to register when the store file is not valid JSON and leaves it byte-identical", async () => {
    const service = await startService()
    const broken = "this is not json"
    await writeFile(service.storePath, broken, "utf8")
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSubscription("https://push.example.com", 1)),
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).not.toContain("not json")
    expect(await readFile(service.storePath, "utf8")).toBe(broken)
  })

  it("refuses to register when the store is not a JSON array", async () => {
    const service = await startService()
    const broken = '{"endpoint":"https://push.example.com/keep"}'
    await writeFile(service.storePath, broken, "utf8")
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSubscription("https://push.example.com", 1)),
    })
    expect(res.status).toBe(500)
    expect(await readFile(service.storePath, "utf8")).toBe(broken)
  })

  it("refuses to register when the store exceeds the size limit", async () => {
    const service = await startService()
    const oversized = `["${"x".repeat(300 * 1024)}"]`
    await writeFile(service.storePath, oversized, "utf8")
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSubscription("https://push.example.com", 1)),
    })
    expect(res.status).toBe(500)
    expect(await readFile(service.storePath, "utf8")).toBe(oversized)
  })

  it("refuses to register when the store path is a directory", async () => {
    const dir = await makeDir("ntfy-bootstrap-dir-store-")
    const service = await startService({ storePath: join(dir, "as-directory") })
    await mkdir(service.storePath)
    const res = await fetch(`${service.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSubscription("https://push.example.com", 1)),
    })
    expect(res.status).toBe(500)
    expect(await readdir(service.storePath)).toEqual([])
  })

  it("refuses to deregister for the same reasons", async () => {
    const service = await startService()
    const broken = "not json"
    await writeFile(service.storePath, broken, "utf8")
    const res = await fetch(`${service.origin}/deregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/x" }),
    })
    expect(res.status).toBe(500)
    expect(await readFile(service.storePath, "utf8")).toBe(broken)
  })
})

describe("startup validation", () => {
  it("rejects a non-empty non-P-256 value as the VAPID public key without echoing it", async () => {
    const dir = await makeDir("ntfy-bootstrap-")
    const privateKeyShaped = randomBytes(32).toString("base64url")
    await expect(startBootstrapService({ storePath: join(dir, "subscriptions.json"), vapidPublicKey: privateKeyShaped })).rejects.toThrow(
      /invalid VAPID public key/,
    )
    await expect(
      startBootstrapService({ storePath: join(dir, "subscriptions.json"), vapidPublicKey: privateKeyShaped }),
    ).rejects.not.toThrow(privateKeyShaped)
  })

  it("rejects an empty store path", async () => {
    await expect(startBootstrapService({ storePath: "  ", vapidPublicKey: makeVapidPublicKey() })).rejects.toThrow(/store path/)
  })

  it("rejects an out-of-range port", async () => {
    const dir = await makeDir("ntfy-bootstrap-")
    await expect(
      startBootstrapService({ storePath: join(dir, "subscriptions.json"), vapidPublicKey: makeVapidPublicKey(), port: 70000 }),
    ).rejects.toThrow(/port/)
  })
})

describe("CLI argument parsing", () => {
  it("parses flags with defaults for host and port", () => {
    // Empty env: without it, parseBootstrapArgs falls back to process.env and
    // a hosting environment's OPENCODE_NTFY_* variables would shadow the defaults.
    const args = parseBootstrapArgs(["--store", "/srv/subscriptions.json", "--vapid-public-key", makeVapidPublicKey()], {})
    expect(args.storePath).toBe("/srv/subscriptions.json")
    expect(args.host).toBe("127.0.0.1")
    expect(args.port).toBe(8089)
  })

  it("accepts --option=value forms", () => {
    const args = parseBootstrapArgs([`--store=/srv/subscriptions.json`, "--port=9999", "--vapid-public-key=" + makeVapidPublicKey()], {})
    expect(args.storePath).toBe("/srv/subscriptions.json")
    expect(args.port).toBe(9999)
  })

  it("falls back to the environment and lets flags win", () => {
    const env = {
      OPENCODE_NTFY_SUBSCRIPTION_STORE: "/env/subscriptions.json",
      OPENCODE_NTFY_VAPID_PUBLIC_KEY: makeVapidPublicKey(),
      OPENCODE_NTFY_HOST: "0.0.0.0",
      OPENCODE_NTFY_PORT: "9999",
    }
    expect(parseBootstrapArgs([], env)).toEqual({ storePath: "/env/subscriptions.json", vapidPublicKey: env["OPENCODE_NTFY_VAPID_PUBLIC_KEY"], host: "0.0.0.0", port: 9999 })
    const override = parseBootstrapArgs(["--store", "/flag/subscriptions.json", "--port", "0"], env)
    expect(override.storePath).toBe("/flag/subscriptions.json")
    expect(override.port).toBe(0)
  })

  it("names the missing option and its environment variable", () => {
    expect(() => parseBootstrapArgs([], {})).toThrow(/--store.*OPENCODE_NTFY_SUBSCRIPTION_STORE/s)
    expect(() => parseBootstrapArgs(["--store", "/x"], {})).toThrow(/--vapid-public-key.*OPENCODE_NTFY_VAPID_PUBLIC_KEY/s)
  })

  it("rejects unknown options, so there is no private-key option anywhere", () => {
    expect(() => parseBootstrapArgs(["--vapid-private-key", "whatever", "--store", "/x", "--vapid-public-key", "y"], {})).toThrow(/unknown option "--vapid-private-key"/)
  })

  it("rejects a non-numeric port and an option without a value", () => {
    expect(() => parseBootstrapArgs(["--store", "/x", "--vapid-public-key", "y", "--port", "abc"], {})).toThrow(/--port/)
    expect(() => parseBootstrapArgs(["--store"], {})).toThrow(/missing value/)
  })

  it("prints usage and exits 0 on --help without starting a server", async () => {
    const stdout = process.stdout.write
    let printed = ""
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      expect(await runBootstrapCli(["--help"])).toBe(0)
    } finally {
      process.stdout.write = stdout
    }
    expect(printed).toContain("--vapid-public-key")
    expect(printed).toContain("POST /register")
  })
})

describe("routing matrix", () => {
  it("answers 404 with a JSON error for unknown paths", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: expect.any(String) })
  })

  it("answers 405 for a GET on the POST endpoints and a POST on the page", async () => {
    const service = await startService()
    const wrongMethodOnRegister = await fetch(`${service.origin}/register`)
    expect(wrongMethodOnRegister.status).toBe(405)
    expect(wrongMethodOnRegister.headers.get("allow")).toBe("POST")
    const wrongMethodOnPage = await fetch(`${service.origin}/`, { method: "POST" })
    expect(wrongMethodOnPage.status).toBe(405)
  })

  it("answers 405 for methods other than GET and POST", async () => {
    const service = await startService()
    const res = await fetch(`${service.origin}/deregister`, { method: "DELETE" })
    expect(res.status).toBe(405)
  })
})
