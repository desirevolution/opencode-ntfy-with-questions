#!/usr/bin/env node
/**
 * Bootstrap Service (ADR-0001): the small register/deregister service a user
 * hosts behind their TLS reverse proxy. A browser opens the page, subscribes
 * via the Push API with the served public VAPID key, and POSTs the resulting
 * PushSubscription; the service appends it, idempotently, to the Subscription
 * Store file the webpush Adapter re-reads at publish time. Deregistration is
 * the mirror image: the browser unsubscribes its own subscription and posts
 * the endpoint; the service removes the entry if present.
 *
 * The service holds no accounts and no data beyond Subscriptions. The only
 * secret-adjacent material it ever touches is the public VAPID key; the
 * private key is never accepted by any option of this module. Endpoints are
 * never logged or echoed: HTTP error responses carry fixed, value-free text,
 * and log lines name only outcomes and counts.
 *
 * Store discipline is the plugin's: reads go through the shared strict store
 * loader, writes go through the shared atomic writer (temp file + rename).
 * A store that cannot be read or parsed refuses the change (HTTP 500) rather
 * than being overwritten, so a bad request or a broken file can never
 * truncate existing Subscriptions.
 *
 * Packaging: compiled to `dist/bootstrap-service.js` and declared as the
 * package's `bin` (`opencode-notifications-bootstrap`), invokable directly as
 * `node .../dist/bootstrap-service.js` too. Store path and public VAPID key
 * come from flags or environment at invocation — never hardcoded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

import {
  loadSubscriptionStore,
  SubscriptionStoreReadError,
  writeSubscriptionStore,
} from "./subscription-store.js"
import type { Logger } from "./types.js"
import { bootstrapPageHtml, serviceWorkerJs } from "./bootstrap-page.js"

export interface BootstrapServiceOptions {
  /** Subscription Store file; the same file the plugin's `webpush.storePath` names. */
  storePath: string
  /** The plugin's public VAPID key (`webpush.publicKey`); served to browsers. */
  vapidPublicKey: string
  /** Address to bind. Default `127.0.0.1` — the reverse proxy fronts this service. */
  host?: string
  /** TCP port. Default `8089`; `0` lets the OS pick a port. */
  port?: number
  /** Secret-safe log sink; log lines never contain endpoints or key material. */
  log?: Logger
}

export interface BootstrapServiceHandle {
  /** Bound address (resolved when `port: 0` was requested). */
  host: string
  /** Bound port (resolved when `port: 0` was requested). */
  port: number
  /** Stops the server and drops its open connections. */
  close(): Promise<void>
}

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8089

/**
 * Upper bound for one request body in bytes. A PushSubscription JSON is a few
 * hundred bytes; anything beyond this is rejected without buffering it.
 */
const MAX_BODY_BYTES = 8192

/** Thrown for request payloads that fail the strict shape validation. */
export class MalformedRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MalformedRequestError"
  }
}

/**
 * Canonical base64url decoding: the value must consist of base64url
 * characters only and re-encode to itself (no padding, no other alphabets).
 */
function decodeCanonicalBase64url(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value === "") return undefined
  if (/[^A-Za-z0-9_-]/.test(value)) return undefined
  const bytes = Buffer.from(value, "base64url")
  if (bytes.toString("base64url") !== value) return undefined
  return bytes
}

/** The public VAPID key shape the webpush config validation accepts: 65-byte uncompressed P-256. */
export function isVapidPublicKey(value: unknown): value is string {
  const bytes = decodeCanonicalBase64url(value)
  return bytes !== undefined && bytes.length === 65 && bytes[0] === 0x04
}

const SUBSCRIPTION_FIELDS = new Set(["endpoint", "keys", "expirationTime"])
const SUBSCRIPTION_KEY_FIELDS = new Set(["p256dh", "auth"])
const SUBSCRIPTION_BODY_ERROR =
  "expected a JSON object with the fields endpoint and keys, and an optional expirationTime (null or epoch milliseconds)"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Strict shape validation of a posted PushSubscription (exactly
 * `PushSubscription.toJSON()` as emitted by real browsers): endpoint is an
 * https URL, keys.p256dh is a canonical base64url 65-byte uncompressed P-256
 * key, keys.auth is a canonical base64url 16-byte auth secret (RFC 8291), and
 * the optional `expirationTime` is either null or a non-negative integer
 * epoch in milliseconds. Unknown or missing fields are rejected. The stored
 * entry is normalized to `{endpoint, keys}`: the publish path uses those two
 * fields only, and expired subscriptions are handled by 410/404 cleanup.
 * Error messages name fields, never values.
 */
export function parseSubscriptionBody(body: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new MalformedRequestError("the request body is not valid JSON")
  }
  if (!isPlainObject(parsed)) throw new MalformedRequestError(SUBSCRIPTION_BODY_ERROR)
  for (const key of Object.keys(parsed)) {
    if (!SUBSCRIPTION_FIELDS.has(key)) {
      throw new MalformedRequestError(SUBSCRIPTION_BODY_ERROR)
    }
  }
  if ("expirationTime" in parsed) {
    const expirationTime = parsed["expirationTime"]
    const valid =
      expirationTime === null || (typeof expirationTime === "number" && Number.isInteger(expirationTime) && expirationTime >= 0)
    if (!valid) throw new MalformedRequestError(SUBSCRIPTION_BODY_ERROR)
  }
  const endpoint = parsed["endpoint"]
  if (typeof endpoint !== "string") throw new MalformedRequestError("endpoint must be an https URL string")
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new MalformedRequestError("endpoint must be an https URL string")
  }
  if (parsedEndpoint.protocol !== "https:") throw new MalformedRequestError("endpoint must be an https URL string")
  const keys = parsed["keys"]
  if (!isPlainObject(keys)) throw new MalformedRequestError("keys must be an object with exactly the fields p256dh and auth")
  for (const key of Object.keys(keys)) {
    if (!SUBSCRIPTION_KEY_FIELDS.has(key)) {
      throw new MalformedRequestError("keys must be an object with exactly the fields p256dh and auth")
    }
  }
  const p256dh = decodeCanonicalBase64url(keys["p256dh"])
  if (p256dh === undefined || p256dh.length !== 65 || p256dh[0] !== 0x04) {
    throw new MalformedRequestError("keys.p256dh must be a base64url-encoded 65-byte uncompressed P-256 key")
  }
  const auth = decodeCanonicalBase64url(keys["auth"])
  if (auth === undefined || auth.length !== 16) {
    throw new MalformedRequestError("keys.auth must be a base64url-encoded 16-byte auth secret")
  }
  return { endpoint, keys: { p256dh: keys["p256dh"] as string, auth: keys["auth"] as string } }
}

/** Strict shape of a deregistration: exactly `{"endpoint": "<https URL>"}`. */
export function parseDeregisterBody(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new MalformedRequestError("the request body is not valid JSON")
  }
  if (!isPlainObject(parsed)) throw new MalformedRequestError("expected a JSON object with exactly the field endpoint")
  for (const key of Object.keys(parsed)) {
    if (key !== "endpoint") throw new MalformedRequestError("expected a JSON object with exactly the field endpoint")
  }
  const endpoint = parsed["endpoint"]
  if (typeof endpoint !== "string") throw new MalformedRequestError("endpoint must be an https URL string")
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new MalformedRequestError("endpoint must be an https URL string")
  }
  if (parsedEndpoint.protocol !== "https:") throw new MalformedRequestError("endpoint must be an https URL string")
  return endpoint
}

/** The endpoint URL of a raw store item, if it has a string one. */
function endpointOf(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined
  const endpoint = item["endpoint"]
  return typeof endpoint === "string" ? endpoint : undefined
}

/** Whether a raw store item already carries exactly this Subscription. */
function sameSubscription(item: unknown, entry: { endpoint: string; keys: { p256dh: string; auth: string } }): boolean {
  if (!isPlainObject(item)) return false
  const keys = item["keys"]
  if (!isPlainObject(keys)) return false
  return item["endpoint"] === entry.endpoint && keys["p256dh"] === entry.keys.p256dh && keys["auth"] === entry.keys.auth
}

export interface StoreMutationOutcome {
  outcome: "registered" | "replaced" | "unchanged" | "removed" | "absent"
  /** Number of entries the store holds after the mutation. */
  total: number
}

/**
 * Store mutations are serialized within this process: every register and
 * deregister reads the store fresh and rewrites it atomically, so two
 * overlapping mutations must not interleave their read-modify-write. (This
 * is in-process ordering; see the README caveat about the plugin's own
 * 410-Gone cleanup running in a separate opencode process.)
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

/**
 * Idempotent register: a duplicate endpoint with identical keys is a no-op
 * (the file is left untouched), a duplicate endpoint with fresh keys is
 * replaced in place, everything else is appended. Duplicate endpoints are
 * never stored twice.
 */
export async function applyRegister(
  storePath: string,
  entry: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<StoreMutationOutcome> {
  const items = await loadSubscriptionStore(storePath)
  const index = items.findIndex((item) => endpointOf(item) === entry.endpoint)
  if (index === -1) {
    await writeSubscriptionStore(storePath, [...items, entry])
    return { outcome: "registered", total: items.length + 1 }
  }
  const existing = items[index]!
  if (sameSubscription(existing, entry)) {
    return { outcome: "unchanged", total: items.length }
  }
  const next = items.slice()
  next[index] = entry
  await writeSubscriptionStore(storePath, next)
  return { outcome: "replaced", total: next.length }
}

/**
 * Idempotent deregister: removes the entry with the given endpoint when
 * present and leaves every other entry — including foreign or malformed
 * ones — untouched; an endpoint that is not in the store is a no-op.
 */
export async function applyDeregister(storePath: string, endpoint: string): Promise<StoreMutationOutcome> {
  const items = await loadSubscriptionStore(storePath)
  const kept = items.filter((item) => endpointOf(item) !== endpoint)
  if (kept.length === items.length) {
    return { outcome: "absent", total: items.length }
  }
  await writeSubscriptionStore(storePath, kept)
  return { outcome: "removed", total: kept.length }
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.setHeader("content-length", Buffer.byteLength(body))
  res.end(body)
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status
  res.setHeader("content-type", contentType)
  res.setHeader("content-length", Buffer.byteLength(body))
  res.end(body)
}

function sendNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("allow", allow)
  sendJson(res, 405, { ok: false, error: "method not allowed" })
}

function errorCodeOf(cause: unknown): string {
  if (cause instanceof SubscriptionStoreReadError) return cause.code
  return cause instanceof Error && "code" in cause ? String((cause as { code?: unknown }).code) : "ERROR"
}

/**
 * Reads the request body, refusing anything beyond MAX_BODY_BYTES (returns
 * undefined; the caller answers 413 and closes the connection).
 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = chunk as Buffer
    total += bytes.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function contentTypeIsJson(req: IncomingMessage): boolean {
  const header = req.headers["content-type"]
  if (typeof header !== "string") return false
  return header.split(";")[0]?.trim().toLowerCase() === "application/json"
}

interface RequestContext {
  storePath: string
  vapidPublicKey: string
  log: Logger
  enqueueMutation: <T>(task: () => Promise<T>) => Promise<T>
}

async function handleRequest(ctx: RequestContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("x-content-type-options", "nosniff")
  res.setHeader("cache-control", "no-store")
  const method = req.method ?? ""
  const path = new URL(req.url ?? "/", "http://bootstrap.invalid").pathname
  if (method !== "GET" && method !== "POST") {
    sendNotAllowed(res, path === "/register" || path === "/deregister" ? "POST" : "GET, POST")
    return
  }
  if (path === "/" || path === "/index.html") {
    if (method !== "GET") {
      sendNotAllowed(res, "GET")
      return
    }
    sendText(res, 200, "text/html; charset=utf-8", bootstrapPageHtml(ctx.vapidPublicKey))
    return
  }
  if (path === "/service-worker.js") {
    if (method !== "GET") {
      sendNotAllowed(res, "GET")
      return
    }
    sendText(res, 200, "text/javascript; charset=utf-8", serviceWorkerJs)
    return
  }
  if (path === "/register" || path === "/deregister") {
    if (method !== "POST") {
      sendNotAllowed(res, "POST")
      return
    }
    if (!contentTypeIsJson(req)) {
      sendJson(res, 415, { ok: false, error: "expected a content-type of application/json" })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      res.once("finish", () => req.destroy())
      sendJson(res, 413, { ok: false, error: "the request body is too large" })
      return
    }
    try {
      if (path === "/register") {
        const entry = parseSubscriptionBody(body)
        const { outcome, total } = await ctx.enqueueMutation(() => applyRegister(ctx.storePath, entry))
        ctx.log(`bootstrap: subscription ${outcome} (store holds ${total} entries)`)
        sendJson(res, 200, { ok: true, result: outcome })
      } else {
        const endpoint = parseDeregisterBody(body)
        const { outcome, total } = await ctx.enqueueMutation(() => applyDeregister(ctx.storePath, endpoint))
        ctx.log(`bootstrap: subscription ${outcome} (store holds ${total} entries)`)
        sendJson(res, 200, { ok: true, result: outcome })
      }
    } catch (cause) {
      if (cause instanceof MalformedRequestError) {
        // The message is a fixed, value-free validation text by construction.
        sendJson(res, 400, { ok: false, error: cause.message })
        return
      }
      ctx.log(`bootstrap: store update refused (${errorCodeOf(cause)}); no change was made`)
      sendJson(res, 500, { ok: false, error: "the subscription store is unavailable; no change was made" })
    }
    return
  }
  sendJson(res, 404, { ok: false, error: "not found" })
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: unknown): void => reject(cause)
    server.once("error", onError)
    server.listen(port, host, () => {
      server.removeListener("error", onError)
      resolve()
    })
  })
}

/** Starts the Bootstrap Service. Resolves once the server is listening. */
export async function startBootstrapService(options: BootstrapServiceOptions): Promise<BootstrapServiceHandle> {
  const storePath = options.storePath
  if (typeof storePath !== "string" || storePath.trim() === "") {
    throw new Error("invalid store path: expected a non-empty Subscription Store file path")
  }
  if (!isVapidPublicKey(options.vapidPublicKey)) {
    throw new Error(
      'invalid VAPID public key: expected a base64url-encoded 65-byte uncompressed P-256 key (the webpush "publicKey" config value; the private key is never accepted)',
    )
  }
  const host = options.host ?? DEFAULT_HOST
  if (typeof host !== "string" || host === "") throw new Error("invalid host: expected a non-empty host name or address")
  const port = options.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("invalid port: expected an integer between 0 and 65535")
  }
  const log: Logger = options.log ?? (() => {})
  const ctx: RequestContext = { storePath, vapidPublicKey: options.vapidPublicKey, log, enqueueMutation: serializeMutations() }
  const server = createServer((req, res) => {
    void handleRequest(ctx, req, res).catch((cause: unknown) => {
      log(`bootstrap: request handling failed (${errorCodeOf(cause)})`)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal error" })
      } else {
        res.destroy()
      }
    })
  })
  await listen(server, host, port)
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("bootstrap service could not determine its bound address")
  }
  log(`bootstrap: listening on http://${address.address}:${address.port} (subscription store: ${storePath})`)
  return {
    host: address.address,
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

const USAGE = `opencode-notifications-bootstrap - register/deregister service for opencode Web Push notifications

Usage:
  opencode-notifications-bootstrap --store <path> --vapid-public-key <key> [--host <addr>] [--port <n>]

Options (each also reads from the environment, named in brackets):
  --store <path>             Subscription Store file, the same file as the
                             plugin's webpush.storePath
                             [OPENCODE_NTFY_SUBSCRIPTION_STORE]
  --vapid-public-key <key>   the plugin's public VAPID key (webpush.publicKey);
                             the private key is never accepted
                             [OPENCODE_NTFY_VAPID_PUBLIC_KEY]
  --host <addr>              address to bind (default 127.0.0.1; keep it
                             loopback and put your TLS reverse proxy in front)
                             [OPENCODE_NTFY_HOST]
  --port <n>                 TCP port (default 8089; 0 picks a free port)
                             [OPENCODE_NTFY_PORT]
  -h, --help                 show this help

Routes:
  GET  /                    the register/deregister page
  GET  /service-worker.js   the page's push service worker
  POST /register            body: the browser's PushSubscription.toJSON()
  POST /deregister          body: {"endpoint": "https://..."}

Host this behind your reverse proxy with TLS: browsers only expose the Push
API in secure contexts. See the README section "Bootstrap Service" for the
proxy setup, the same-host caveat and the multi-host copy path.`

export interface BootstrapCliOptions {
  storePath: string
  vapidPublicKey: string
  host: string
  port: number
}

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]
  if (value === undefined) throw new Error(`missing value for ${option}`)
  return value
}

function parsePort(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error("invalid --port: expected an integer between 0 and 65535")
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("invalid --port: expected an integer between 0 and 65535")
  }
  return port
}

/**
 * Parses CLI flags with environment fallbacks. Unknown options are rejected
 * — in particular no private-key option exists anywhere in this module.
 */
export function parseBootstrapArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): BootstrapCliOptions {
  let storePath: string | undefined
  let vapidPublicKey: string | undefined
  let host: string | undefined
  let port: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const [name, inlineValue] = arg.startsWith("--") && arg.includes("=") ? splitInlineOption(arg) : [arg, undefined]
    const takeValue = (): string => (inlineValue !== undefined ? inlineValue : requireValue(argv, (i += 1), name))
    switch (name) {
      case "--store":
        storePath = takeValue()
        break
      case "--vapid-public-key":
        vapidPublicKey = takeValue()
        break
      case "--host":
        host = takeValue()
        break
      case "--port":
        port = parsePort(takeValue())
        break
      default:
        throw new Error(`unknown option "${name}" (see --help)`)
    }
  }
  storePath ??= env["OPENCODE_NTFY_SUBSCRIPTION_STORE"]
  vapidPublicKey ??= env["OPENCODE_NTFY_VAPID_PUBLIC_KEY"]
  host ??= env["OPENCODE_NTFY_HOST"] ?? DEFAULT_HOST
  if (port === undefined) {
    const envPort = env["OPENCODE_NTFY_PORT"]
    port = envPort === undefined ? DEFAULT_PORT : parsePort(envPort)
  }
  if (storePath === undefined || storePath.trim() === "") {
    throw new Error("missing required option --store (or environment variable OPENCODE_NTFY_SUBSCRIPTION_STORE)")
  }
  if (vapidPublicKey === undefined || vapidPublicKey.trim() === "") {
    throw new Error("missing required option --vapid-public-key (or environment variable OPENCODE_NTFY_VAPID_PUBLIC_KEY)")
  }
  return { storePath, vapidPublicKey, host, port }
}

function splitInlineOption(arg: string): [string, string] {
  const equals = arg.indexOf("=")
  return [arg.slice(0, equals), arg.slice(equals + 1)]
}

/**
 * Runs the CLI: parse, start, keep serving until SIGINT/SIGTERM. Returns the
 * process exit code once the server has closed.
 */
export async function runBootstrapCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  let options: BootstrapCliOptions
  try {
    options = parseBootstrapArgs(argv, env)
  } catch (cause) {
    process.stderr.write(`opencode-notifications-bootstrap: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  let handle: BootstrapServiceHandle
  try {
    handle = await startBootstrapService({ ...options, log: (message) => process.stdout.write(`${message}\n`) })
  } catch (cause) {
    process.stderr.write(`opencode-notifications-bootstrap: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    process.stdout.write("bootstrap: shutting down\n")
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  await new Promise<void>(() => {
    // The server keeps the event loop alive; shutdown closes it.
  })
  return 0
}

/** True when this module is the process entry (direct node or bin invocation, symlink-resolved). */
function isMainModule(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || entry === "") return false
  try {
    if (pathToFileURL(entry).href === import.meta.url) return true
  } catch {
    return false
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMainModule()) {
  void runBootstrapCli(process.argv.slice(2))
}
