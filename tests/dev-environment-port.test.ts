/** Regression coverage for the additional Dev-Environment Web Push features.
 * The newer fork's agent.notify, idle enrichment and multi-project handling
 * remain unchanged by this port.
 */
import { createECDH, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { buildBootstrapTestPayload, parseBootstrapArgs, startBootstrapService, type BootstrapServiceHandle } from "../src/bootstrap-service.js"
import { bootstrapPageHtml, serviceWorkerJs } from "../src/bootstrap-page.js"
import { createPluginHandlers } from "../src/notification-handlers.js"
import { openCodeWebTarget } from "../src/webui-link.js"
import type { TransportAdapter } from "../src/transport.js"
import type { NotificationDraft } from "../src/types.js"

const vapidPublicKey = "BCbA4oS2TxtmqASPvdeQyFUoNnqMtb3uzmjouUBAkfDWsb0yR84iDS3Mrs7Pn2wconyNd_PkMKaItjHEOHv_ezs"
const vapidPrivateKey = "5K7qXP8V_-j1U-F8puy98fO-8q_s9m9xIdo1n4jsKpg"
const dirs: string[] = []
const running: BootstrapServiceHandle[] = []
afterEach(async () => {
  for (const handle of running.splice(0)) await handle.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const settings = { webUiBaseUrl: "https://code.example.com/", webUiServerUrl: "http://127.0.0.1:4096/" }

describe("web push click destinations", () => {
  it("generates the OpenCode Web session URL and falls back to the homepage", () => {
    const key = Buffer.from("http://127.0.0.1:4096", "utf8").toString("base64url")
    expect(openCodeWebTarget(settings, "ses_123")).toBe(`https://code.example.com/server/${key}/session/ses_123`)
    expect(openCodeWebTarget(settings, "../../invalid")).toBe("https://code.example.com/")
    expect(openCodeWebTarget({}, "ses_123")).toBeUndefined()
  })

  it("validates opt-in configuration, without removing the fork's agent notifications", () => {
    const config = normalizeConfig({
      transport: "webpush", permissionNotificationDelayMs: 0,
      webpush: {
        subject: "mailto:dev@example.com", publicKey: vapidPublicKey,
        privateKey: vapidPrivateKey, storePath: "/tmp/webpush.json",
        webUiBaseUrl: "https://code.example.com", webUiServerUrl: "http://127.0.0.1:4096",
      },
    })
    if (config.transport !== "webpush") throw new Error("unexpected transport")
    expect(config.webpush.webUiBaseUrl).toBe("https://code.example.com/")
    expect(config.webpush.webUiServerUrl).toBe("http://127.0.0.1:4096/")
    expect(config.events["agent.notify"]).toBe(true)
    expect(config.enrichIdleMessages).toBe(true)
    expect(() => normalizeConfig({ transport: "webpush", webpush: {
      subject: "mailto:dev@example.com", publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey, storePath: "/tmp/webpush.json", webUiServerUrl: "http://server/",
    } })).toThrow(/requires/)
    expect(() => normalizeConfig({ transport: "webpush", webpush: {
      subject: "mailto:dev@example.com", publicKey: vapidPublicKey,
      privateKey: vapidPrivateKey, storePath: "/tmp/webpush.json", webUiBaseUrl: "https://user:secret@code.example.com/",
    } })).toThrow()
  })

  it("adds destinations to question and explicit agent notification drafts", async () => {
    const config = normalizeConfig({
      transport: "webpush", permissionNotificationDelayMs: 0,
      webpush: {
        subject: "mailto:dev@example.com", publicKey: vapidPublicKey,
        privateKey: vapidPrivateKey, storePath: "/tmp/webpush.json", ...settings,
      },
    })
    const sent: NotificationDraft[] = []
    const transport = { publish: async (draft: NotificationDraft) => { sent.push(draft) }, describeError: () => "error" } as TransportAdapter
    const handlers = createPluginHandlers({
      config, directory: "/project", projectName: "example", getSession: async () => ({}), transport,
    })
    await handlers.question("question", { question: "Proceed?" }, "ses_123")
    await handlers.notify("opencode_notify", { title: "Done", body: "Finished" }, "ses_123")
    expect(sent).toHaveLength(2)
    expect(sent[0]?.url).toContain("/session/ses_123")
    expect(sent[1]?.kind).toBe("agent.notify")
    expect(sent[1]?.url).toBe(sent[0]?.url)
    await handlers.dispose()
  })
})

describe("registration UI and test sender", () => {
  it("exposes three buttons and notification click handling", () => {
    expect(bootstrapPageHtml(vapidPublicKey)).toContain('id="test"')
    expect(bootstrapPageHtml(vapidPublicKey)).toContain('id="state-label"')
    expect(serviceWorkerJs).toContain('addEventListener("notificationclick"')
    expect(serviceWorkerJs).toContain("openWindow")
    expect(JSON.parse(buildBootstrapTestPayload("https://code.example.com"))).toMatchObject({ kind: "test", url: "https://code.example.com" })
  })

  it("accepts the optional private-key file flags without requiring raw secrets on the command line", () => {
    const opts = parseBootstrapArgs(["--store", "/tmp/store.json", "--vapid-public-key", vapidPublicKey,
      "--vapid-private-key-file", "/tmp/private", "--vapid-subject", "mailto:dev@example.com", "--test-url", "https://code.example.com"])
    expect(opts.vapidPrivateKeyFile).toBe("/tmp/private")
    expect(opts.vapidSubject).toBe("mailto:dev@example.com")
  })

  it("sends only to a registered endpoint, enforces throttling and rejects cross-origin requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfy-dev-port-"))
    dirs.push(dir)
    const storePath = join(dir, "subscriptions.json")
    const ecdh = createECDH("prime256v1")
    ecdh.generateKeys()
    const sub = { endpoint: "https://push.example.com/subscribed-1", keys: { p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url") } }
    await writeFile(storePath, JSON.stringify([sub]))
    const sent: string[] = []
    const server = await startBootstrapService({
      storePath, vapidPublicKey, host: "127.0.0.1", port: 0,
      testPush: async (entry) => { sent.push(entry.endpoint) },
    })
    running.push(server)
    const url = `http://127.0.0.1:${server.port}/test`
    const post = (endpoint: string, origin?: string) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ endpoint }),
    })
    expect((await post("https://push.example.com/missing")).status).toBe(404)
    expect((await post(sub.endpoint, "https://attacker.example.com")).status).toBe(403)
    expect((await post(sub.endpoint)).status).toBe(200)
    expect((await post(sub.endpoint)).status).toBe(429)
    expect(sent).toEqual([sub.endpoint])
  })
})
