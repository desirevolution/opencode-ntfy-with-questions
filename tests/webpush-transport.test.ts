/**
 * Web Push Adapter tests at the highest honest seam: the adapter publishes
 * through the real web-push library against a local ephemeral HTTPS endpoint
 * (self-signed test cert, accepted via an injectable https.Agent) and the
 * captured ciphertexts are decrypted per RFC 8291 with the receiver-held key.
 * The store is exercised over real temp files; no filesystem or network mocks.
 */

import { readFileSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { IncomingMessage } from "node:http"
import { Agent } from "node:https"
import { createServer, type Server } from "node:https"
import { join } from "node:path"
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify as cryptoVerify,
} from "node:crypto"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { WebPushError } from "web-push"

import { createWebPushTransport, describeWebpushError } from "../src/webpush-transport.js"
import type { NotificationDraft, WebPushSettings } from "../src/types.js"

// A fixed VAPID keypair for deterministic tests, generated once with
// `npx web-push generate-vapid-keys --json`. Test-only, never shipped.
const TEST_VAPID_PUBLIC_KEY = "BCbA4oS2TxtmqASPvdeQyFUoNnqMtb3uzmjouUBAkfDWsb0yR84iDS3Mrs7Pn2wconyNd_PkMKaItjHEOHv_ezs"
const TEST_VAPID_PRIVATE_KEY = "5K7qXP8V_-j1U-F8puy98fO-8q_s9m9xIdo1n4jsKpg"

// Test-only fixtures for the local TLS push-endpoint stub; never reuse, ship
// or trust them outside this suite.
const CERT_PEM = readFileSync(new URL("./fixtures/webpush-endpoint.crt", import.meta.url), "utf8")
const KEY_PEM = readFileSync(new URL("./fixtures/webpush-endpoint.key", import.meta.url), "utf8")

const tempDirs: string[] = []
const openServers: Server[] = []
let sharedAgent: Agent | undefined

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
  while (openServers.length > 0) {
    const server = openServers.pop()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

afterAll(() => {
  sharedAgent?.destroy()
})

function makeAgent(): Agent {
  sharedAgent ??= new Agent({ rejectUnauthorized: false })
  return sharedAgent
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-webpush-"))
  tempDirs.push(dir)
  return dir
}

function logSink(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = []
  return { lines, log: (message) => lines.push(message) }
}

/** Drains the microtask queue so late per-subscription log lines are visible. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

interface CapturedRequest {
  headers: IncomingMessage["headers"]
  body: Buffer
  url: string | undefined
}

interface EndpointHandle {
  origin: string
  requests: CapturedRequest[]
  /** Makes one path answer with the given status (default: 201). */
  respond: (path: string, status: number) => void
  /** Keeps the request open without ever responding (for deadline tests). */
  stall: (path: string) => void
}

async function startEndpoint(): Promise<EndpointHandle> {
  const requests: CapturedRequest[] = []
  const statusByPath = new Map<string, number>()
  const stalledPaths = new Set<string>()
  const server = createServer({ key: KEY_PEM, cert: CERT_PEM }, (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url })
      if (stalledPaths.has(req.url ?? "")) return
      res.statusCode = statusByPath.get(req.url ?? "") ?? 201
      res.end()
    })
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test bug: endpoint has no port")
  return {
    origin: `https://127.0.0.1:${address.port}`,
    requests,
    respond: (path, status) => statusByPath.set(path, status),
    stall: (path) => stalledPaths.add(path),
  }
}

/** One browser-side receiver: a fresh P-256 keypair plus auth secret. */
function makeReceiver(): { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; ecdh: ReturnType<typeof createECDH>; publicKey: Buffer } {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return {
    subscription: {
      endpoint: "",
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    },
    ecdh,
    publicKey: ecdh.getPublicKey(),
  }
}

function webpushSettings(overrides: Partial<WebPushSettings> = {}): WebPushSettings {
  return {
    subject: "mailto:webpush-test@example.com",
    publicKey: TEST_VAPID_PUBLIC_KEY,
    privateKey: TEST_VAPID_PRIVATE_KEY,
    storePath: "/tmp/opencode/subscriptions.json",
    timeoutMs: 5000,
    ...overrides,
  }
}

async function writeStore(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

const DRAFT: NotificationDraft = {
  kind: "question.asked",
  title: "demo-project: question",
  message: "Should I deploy to production?",
  tags: ["question"],
}

// ---------------------------------------------------------------------------
// RFC 8291 (aes128gcm, RFC 8188 record layer) decryption with receiver-held
// keys only. Independent from the web-push library on purpose: a wrong wire
// format fails here instead of passing by construction.
// ---------------------------------------------------------------------------

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url")
}

/** SPKI header for an uncompressed P-256 point (26 bytes) for crypto.verify. */
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex")

function decryptAes128gcm(
  body: Buffer,
  receiverEcdh: ReturnType<typeof createECDH>,
  receiverPublicKey: Buffer,
  authSecret: Buffer,
): { plaintext: Buffer; senderPublicKey: Buffer } {
  if (body.length < 22) throw new Error("ciphertext too short for an aes128gcm header")
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]!
  const senderPublicKey = body.subarray(21, 21 + idlen)
  if (senderPublicKey.length !== idlen) throw new Error("truncated aes128gcm keyid")
  if (idlen !== 65 || senderPublicKey[0] !== 0x04) {
    throw new Error("aes128gcm keyid is not an uncompressed P-256 point")
  }

  // RFC 8291 section 4: ECDH secret, HKDF with the auth secret as salt and
  // the WebPush info string gives the 32-byte IKM; the record salt then
  // derives the content-encryption key and nonce.
  const ecdhSecret = receiverEcdh.computeSecret(senderPublicKey)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info", "utf8"), Buffer.from([0x00]), receiverPublicKey, senderPublicKey])
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16))
  const nonceBase = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12))

  const plaintexts: Buffer[] = []
  let offset = 21 + idlen
  let sequence = 0
  while (offset < body.length) {
    const end = Math.min(offset + rs, body.length)
    const record = body.subarray(offset, end)
    if (record.length < 17) throw new Error("aes128gcm record too short")
    const ciphertext = record.subarray(0, record.length - 16)
    const tag = record.subarray(record.length - 16)
    // The record nonce is the base nonce with the sequence number XORed into
    // its trailing 64 bits (RFC 8188 section 2).
    const nonce = Buffer.from(nonceBase)
    const shift = BigInt(sequence)
    for (let i = 0; i < 8; i += 1) {
      const shiftAmount = BigInt(8 * (7 - i))
      nonce[4 + i]! ^= Number((shift >> shiftAmount) & 0xffn)
    }
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
    decipher.setAuthTag(tag)
    plaintexts.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
    offset = end
    sequence += 1
  }
  if (sequence === 0) throw new Error("aes128gcm body has no records")
  const padded = Buffer.concat(plaintexts)
  const delimiter = padded.lastIndexOf(0x02)
  if (delimiter < 0) throw new Error("aes128gcm plaintext has no padding delimiter")
  return { plaintext: padded.subarray(0, delimiter), senderPublicKey }
}

/** Decodes the VAPID JWT of a captured request and verifies it end to end. */
function assertVapidAuthorization(
  headers: IncomingMessage["headers"],
  settings: WebPushSettings,
  endpointOrigin: string,
): void {
  const authorization = headers["authorization"]
  expect(authorization).toBeDefined()
  const match = /^vapid t=([^,]+), k=([^,]+)$/.exec(String(authorization))
  expect(match).not.toBeNull()
  const [, token, k] = match!
  // The k= header field is the configured VAPID public key.
  expect(k).toBe(settings.publicKey)
  const parts = token!.split(".")
  expect(parts).toHaveLength(3)
  const header = JSON.parse(b64urlDecode(parts[0]!).toString("utf8")) as { alg?: string; typ?: string }
  expect(header.alg).toBe("ES256")
  const claims = JSON.parse(b64urlDecode(parts[1]!).toString("utf8")) as { sub?: string; aud?: string; exp?: number }
  expect(claims.sub).toBe(settings.subject)
  expect(claims.aud).toBe(endpointOrigin)
  const now = Math.floor(Date.now() / 1000)
  expect(claims.exp).toBeGreaterThan(now)
  expect(claims.exp).toBeLessThan(now + 13 * 3600)
  // The ES256 signature (IEEE P-1363) verifies against the VAPID public key.
  const signature = b64urlDecode(parts[2]!)
  expect(signature).toHaveLength(64)
  const keyObject = createPublicKey({
    key: Buffer.concat([P256_SPKI_PREFIX, b64urlDecode(settings.publicKey)]),
    format: "der",
    type: "spki",
  })
  const signedData = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8")
  expect(cryptoVerify("sha256", signedData, { key: keyObject, dsaEncoding: "ieee-p1363" }, signature)).toBe(true)
}

interface Delivered {
  request: CapturedRequest
  payload: { kind: string; title: string; message: string; tags: string[] }
}

function expectDeliveredNotification(
  request: CapturedRequest,
  receiver: ReturnType<typeof makeReceiver>,
): Delivered {
  expect(request.headers["content-type"]).toBe("application/octet-stream")
  expect(request.headers["content-encoding"]).toBe("aes128gcm")
  expect(request.headers["ttl"]).toBe("3600")
  const authSecret = b64urlDecode(receiver.subscription.keys.auth)
  const { plaintext } = decryptAes128gcm(request.body, receiver.ecdh, receiver.publicKey, authSecret)
  return { request, payload: JSON.parse(plaintext.toString("utf8")) as Delivered["payload"] }
}

describe("webpush Adapter", () => {
  it("delivers an encrypted visible Notification to every Subscription and the payload decrypts to the draft", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    const receiverA = makeReceiver()
    const receiverB = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...receiverB.subscription, endpoint: `${endpoint.origin}/push-b` },
    ])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent(), log })
    await adapter.publish(DRAFT)

    expect(endpoint.requests).toHaveLength(2)
    const deliveredA = expectDeliveredNotification(endpoint.requests[0]!, receiverA)
    const deliveredB = expectDeliveredNotification(endpoint.requests[1]!, receiverB)
    for (const delivered of [deliveredA, deliveredB]) {
      // Every push is a visible Notification: the payload carries the
      // Notification content the browser displays.
      expect(delivered.payload).toEqual({
        kind: DRAFT.kind,
        title: DRAFT.title,
        message: DRAFT.message,
        tags: DRAFT.tags,
      })
      assertVapidAuthorization(delivered.request.headers, webpushSettings(), endpoint.origin)
    }
    expect(lines).toEqual([])
  })

  it("keeps per-Subscription failure isolation: one failing endpoint does not stop the others", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.respond("/push-broken", 500)
    const receiverA = makeReceiver()
    const receiverB = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...receiverB.subscription, endpoint: `${endpoint.origin}/push-broken` },
    ])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent(), log })
    await adapter.publish(DRAFT)

    // The healthy Subscription is still delivered.
    expect(endpoint.requests).toHaveLength(2)
    const delivered = expectDeliveredNotification(endpoint.requests[0]!, receiverA)
    expect(delivered.payload.message).toBe(DRAFT.message)
    // The failing one is logged per Subscription, without any endpoint or
    // payload detail.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("subscription 2")
    expect(lines[0]).toContain("500")
    expect(lines[0]).not.toContain("push-broken")
    expect(lines[0]).not.toContain(DRAFT.message)
  })

  it("rejects with an aggregate error when no Subscription is delivered", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.respond("/push-a", 500)
    endpoint.respond("/push-b", 503)
    const receiver = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...receiver.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-b` },
    ])
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent() })
    let publishError: unknown
    try {
      await adapter.publish(DRAFT)
    } catch (error) {
      publishError = error
    }
    expect(publishError).toBeInstanceOf(Error)
    expect(String((publishError as Error).message)).toContain("failed for all 2 subscriptions")
    // The log-safe description stays actionable and secret-safe.
    const description = adapter.describeError(publishError)
    expect(description).toContain("webpush")
    expect(description).not.toContain("push-a")
    // A foreign error is never echoed.
    expect(adapter.describeError(new Error("boom with secrets"))).toBe("unexpected webpush publish failure")
  })

  it("removes a 410 Gone endpoint from the store via an atomic write and keeps the others", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.respond("/push-expired", 410)
    const receiverA = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-expired` },
    ])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent(), log })
    await adapter.publish(DRAFT)

    const stored = JSON.parse(await readFile(storePath, "utf8")) as unknown[]
    expect(stored).toEqual([{ ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` }])
    // Atomic write: temp file written and renamed, nothing left behind.
    expect(await readdir(dir)).toEqual(["subscriptions.json"])
    expect(lines.some((line) => line.includes("410"))).toBe(true)
    expect(lines.some((line) => line.includes("push-expired"))).toBe(false)
  })

  it("removes a 404 endpoint too: both statuses mean the Subscription is gone per RFC 8030", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.respond("/push-unknown", 404)
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [{ ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-unknown` }])
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent() })
    // The only Subscription is expired, so nothing is delivered and the
    // publish rejects while the cleanup still happens.
    await expect(adapter.publish(DRAFT)).rejects.toThrow(/failed for all 1 subscriptions/)
    const stored = JSON.parse(await readFile(storePath, "utf8")) as unknown[]
    expect(stored).toEqual([])
  })

  it("skips malformed store entries with a warning and still delivers to the valid ones", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    const receiver = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      "not-an-object",
      { ...receiver.subscription, endpoint: `${endpoint.origin}/push-a` },
      { endpoint: "http://insecure.example.com/push", keys: { p256dh: "x", auth: "y" } },
    ])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent(), log })
    await adapter.publish(DRAFT)

    expect(endpoint.requests).toHaveLength(1)
    expect(lines.some((line) => line.includes("skipped"))).toBe(true)
    expect(lines.some((line) => line.includes("push.example.com"))).toBe(false)
  })

  it("picks up store changes between publishes without a restart", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    const receiverA = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [{ ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` }])
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent() })
    await adapter.publish(DRAFT)
    expect(endpoint.requests).toHaveLength(1)

    // A device registers between publishes: the next publish sees it.
    const receiverB = makeReceiver()
    await writeStore(storePath, [
      { ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...receiverB.subscription, endpoint: `${endpoint.origin}/push-b` },
    ])
    await adapter.publish(DRAFT)
    expect(endpoint.requests).toHaveLength(3)
    expectDeliveredNotification(endpoint.requests[1]!, receiverA)
    expectDeliveredNotification(endpoint.requests[2]!, receiverB)
  })

  it("resolves without sending when the Subscription Store has no subscriptions", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent(), log })
    await adapter.publish(DRAFT)
    expect(endpoint.requests).toHaveLength(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("no subscriptions")
  })

  it("lets a stalled Subscription time out while the others still deliver", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.stall("/push-stalled")
    const receiverA = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...receiverA.subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-stalled` },
    ])
    const { lines, log } = logSink()
    const adapter = createWebPushTransport(webpushSettings({ storePath, timeoutMs: 150 }), { agent: makeAgent(), log })
    const startedAt = Date.now()
    await adapter.publish(DRAFT)
    const elapsed = Date.now() - startedAt
    await flushAsync()
    // The whole fan-out is bounded by the shared publish deadline.
    expect(elapsed).toBeLessThan(5000)
    const delivered = expectDeliveredNotification(
      endpoint.requests.find((request) => request.url === "/push-a")!,
      receiverA,
    )
    expect(delivered.payload.message).toBe(DRAFT.message)
    expect(lines.some((line) => line.includes("timed out"))).toBe(true)
  })

  it("rejects with the timeout error when the whole fan-out misses the deadline", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    endpoint.stall("/push-a")
    endpoint.stall("/push-b")
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [
      { ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-a` },
      { ...makeReceiver().subscription, endpoint: `${endpoint.origin}/push-b` },
    ])
    const adapter = createWebPushTransport(webpushSettings({ storePath, timeoutMs: 120 }), { agent: makeAgent() })
    const startedAt = Date.now()
    let publishError: unknown
    try {
      await adapter.publish(DRAFT)
    } catch (error) {
      publishError = error
    }
    const elapsed = Date.now() - startedAt
    await flushAsync()
    expect(elapsed).toBeLessThan(5000)
    const description = adapter.describeError(publishError)
    expect(description).toMatch(/timed out after 120ms/)
    expect(description).not.toContain("push-a")
  })

  it("truncates an oversized message so the encrypted payload fits push-service limits", async () => {
    const dir = await makeDir()
    const endpoint = await startEndpoint()
    const receiver = makeReceiver()
    const storePath = join(dir, "subscriptions.json")
    await writeStore(storePath, [{ ...receiver.subscription, endpoint: `${endpoint.origin}/push-a` }])
    const adapter = createWebPushTransport(webpushSettings({ storePath }), { agent: makeAgent() })
    const longDraft: NotificationDraft = {
      kind: "session.error",
      title: "demo-project: error",
      message: `An error occurred: ${"detail ".repeat(800)}`,
      tags: ["warning"],
    }
    await adapter.publish(longDraft)

    const request = endpoint.requests[0]!
    // Push services cap the encrypted body at 4096 bytes.
    expect(request.body.length).toBeLessThanOrEqual(4096)
    const { payload } = expectDeliveredNotification(request, receiver)
    expect(payload.title).toBe(longDraft.title)
    expect(payload.tags).toEqual(longDraft.tags)
    expect(payload.message.length).toBeGreaterThan(0)
    expect(payload.message.length).toBeLessThan(longDraft.message.length)
  })

  it("describes HTTP failures of the push service with a sanitized wording", () => {
    const httpError = new WebPushError("Received unexpected response code", 403, {}, "", "https://push.example.com/secret")
    const description = describeWebpushError(httpError)
    expect(description).toBe("webpush push service responded with HTTP status 403")
    // The endpoint URL carries the subscription's secret token: never logged.
    expect(description).not.toContain("secret")
    expect(describeWebpushError(new Error("foreign detail"))).toBe("unexpected webpush publish failure")
  })
})
