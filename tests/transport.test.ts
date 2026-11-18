import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { describeGotifyError, GotifyHttpError } from "../src/gotify-client.js"
import { describeNtfyError, NtfyHttpError } from "../src/ntfy-client.js"
import { createGotifyTransport, createNtfyTransport, createTransport, type TransportAdapter } from "../src/transport.js"
import type { GotifySettings, NtfySettings, PluginConfig } from "../src/types.js"
import { notificationKinds } from "../src/types.js"

// A fixed VAPID keypair for deterministic tests, generated once with
// `npx web-push generate-vapid-keys --json`. Test-only, never shipped.
const TEST_VAPID_PUBLIC_KEY = "BCbA4oS2TxtmqASPvdeQyFUoNnqMtb3uzmjouUBAkfDWsb0yR84iDS3Mrs7Pn2wconyNd_PkMKaItjHEOHv_ezs"
const TEST_VAPID_PRIVATE_KEY = "5K7qXP8V_-j1U-F8puy98fO-8q_s9m9xIdo1n4jsKpg"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function config(
  overrides: { ntfy?: Partial<NtfySettings>; gotify?: Partial<GotifySettings>; transport?: string } = {},
): PluginConfig {
  const transport = overrides.transport
  return normalizeConfig({
    transport,
    // Only the active Transport's section may be present.
    ntfy: transport === "gotify" ? undefined : { topic: "demo-topic", ...overrides.ntfy },
    gotify:
      transport === "gotify" || overrides.gotify !== undefined
        ? { server: "https://gotify.example.com/", token: "Aa1ExampleToken", ...overrides.gotify }
        : undefined,
  })
}

type MockFetch = ReturnType<typeof vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>>
function okFetch(): MockFetch {
  return vi.fn(async () => new Response("{}", { status: 200 }))
}
function requestOf(fetchMock: MockFetch): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url, init }
}

describe("transport selection", () => {
  it("selects the ntfy Adapter when the transport key is absent", async () => {
    const fetchMock = okFetch()
    const adapter = createTransport(config(), { fetch: fetchMock as unknown as typeof fetch })
    await adapter.publish({ kind: "session.idle", title: "T", message: "M", tags: ["tag"] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url } = requestOf(fetchMock)
    expect(url).toBe("https://ntfy.sh/")
  })

  it("selects the ntfy Adapter for an explicit transport ntfy", async () => {
    const fetchMock = okFetch()
    const adapter = createTransport(config({ transport: "ntfy" }), { fetch: fetchMock as unknown as typeof fetch })
    await adapter.publish({ kind: "question.asked", title: "T", message: "M", tags: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("selects the Gotify Adapter for transport gotify", async () => {
    const fetchMock = okFetch()
    const adapter = createTransport(config({ transport: "gotify" }), { fetch: fetchMock as unknown as typeof fetch })
    await adapter.publish({ kind: "session.idle", title: "T", message: "M", tags: ["tag"] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://gotify.example.com/message")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("Aa1ExampleToken")
    expect(JSON.parse(String(init.body))).toEqual({ title: "T", message: "M", priority: 4 })
  })

  it("selects the webpush Adapter when the transport is webpush", async () => {
    // The webpush Adapter never uses the ntfy/gotify fetch boundary: with an
    // empty Subscription Store the publish is a logged no-op instead.
    const fetchMock = okFetch()
    const dir = await mkdtemp(join(tmpdir(), "ntfy-transport-"))
    tempDirs.push(dir)
    const storePath = join(dir, "subscriptions.json")
    await writeFile(storePath, "[]\n", "utf8")
    const logLines: string[] = []
    const adapter = createTransport(
      normalizeConfig({
        transport: "webpush",
        webpush: {
          subject: "mailto:push@example.com",
          publicKey: TEST_VAPID_PUBLIC_KEY,
          privateKey: TEST_VAPID_PRIVATE_KEY,
          storePath,
        },
      }),
      { fetch: fetchMock as unknown as typeof fetch, log: (message) => logLines.push(message) },
    )
    await adapter.publish({ kind: "session.idle", title: "T", message: "M", tags: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logLines.some((line) => line.includes("no subscriptions"))).toBe(true)
  })
  it("produces the documented request for every Notification Kind over the gotify Adapter", async () => {
    for (const kind of notificationKinds) {
      const fetchMock = okFetch()
      const adapter = createTransport(config({ transport: "gotify", gotify: { priority: "max" } }), {
        fetch: fetchMock as unknown as typeof fetch,
      })
      await adapter.publish({ kind, title: `Title ${kind}`, message: "Body", tags: ["tag"] })
      const { url, init } = requestOf(fetchMock)
      expect(url).toBe("https://gotify.example.com/message")
      expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("Aa1ExampleToken")
      expect(JSON.parse(String(init.body))).toEqual({ title: `Title ${kind}`, message: "Body", priority: 10 })
    }
  })
})

describe("ntfy Adapter", () => {
  it("publishes a draft with the same wire request the handler used to send", async () => {
    const fetchMock = okFetch()
    const adapter = createNtfyTransport(
      {
        server: "https://ntfy.example.com/notify/",
        topic: "demo-topic",
        token: "tk_secret",
        priority: "high",
        timeoutMs: 5000,
      },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await adapter.publish({ kind: "permission.asked", title: "Ti:tle", message: "Mes\nsage", tags: ["lock"] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://ntfy.example.com/notify/")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tk_secret")
    expect(JSON.parse(String(init.body))).toEqual({
      topic: "demo-topic",
      title: "Ti:tle",
      message: "Mes\nsage",
      priority: 4,
      tags: ["lock"],
    })
  })

  it("keeps the per-publish deadline of the wrapped client", async () => {
    // A fetch that never settles: only the deadline can end the publish.
    const fetchMock = () => new Promise<Response>(() => {})
    const adapter = createNtfyTransport(
      { server: "https://ntfy.sh/", topic: "t", priority: "default", timeoutMs: 10 },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await expect(adapter.publish({ kind: "session.idle", title: "T", message: "M", tags: [] })).rejects.toThrow(
      /timed out after 10ms/,
    )
  })

  it("describes HTTP failures with the sanitized ntfy wording", async () => {
    const adapter = createNtfyTransport(
      { server: "https://ntfy.sh/", topic: "t", priority: "default", timeoutMs: 5000 },
      {},
    )
    expect(adapter.describeError(new NtfyHttpError("boom", 403))).toBe("ntfy server responded with HTTP status 403")
    expect(adapter.describeError(new Error("foreign detail"))).toBe(describeNtfyError(new Error("foreign detail")))
  })

  it("satisfies the Transport Adapter seam so handlers can depend on it", async () => {
    const sent: string[] = []
    const fake: TransportAdapter = {
      publish: async (draft) => {
        sent.push(`${draft.kind}:${draft.title}`)
      },
      describeError: () => "publish failed",
    }
    await fake.publish({ kind: "session.idle", title: "T", message: "M", tags: [] })
    expect(sent).toEqual(["session.idle:T"])
  })
})

describe("gotify Adapter", () => {
  it("publishes a draft to the message endpoint with the token in the header", async () => {
    const fetchMock = okFetch()
    const adapter = createGotifyTransport(
      {
        server: "https://gotify.example.com/push/",
        token: "Aa1ExampleToken",
        priority: "high",
        timeoutMs: 5000,
      },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await adapter.publish({ kind: "permission.asked", title: "Ti:tle", message: "Mes\nsage", tags: ["lock"] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://gotify.example.com/push/message")
    expect(url).not.toContain("Aa1ExampleToken")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("Aa1ExampleToken")
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Ti:tle",
      message: "Mes\nsage",
      priority: 8,
    })
  })

  it("keeps the per-publish deadline of the shared Transport contract", async () => {
    // A fetch that never settles: only the deadline can end the publish.
    const fetchMock = () => new Promise<Response>(() => {})
    const adapter = createGotifyTransport(
      { server: "https://gotify.example.com/", token: "Aa1ExampleToken", priority: "default", timeoutMs: 10 },
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await expect(adapter.publish({ kind: "session.idle", title: "T", message: "M", tags: [] })).rejects.toThrow(
      /timed out after 10ms/,
    )
  })

  it("describes HTTP failures with the sanitized gotify wording", async () => {
    const adapter = createGotifyTransport(
      { server: "https://gotify.example.com/", token: "Aa1ExampleToken", priority: "default", timeoutMs: 5000 },
      {},
    )
    expect(adapter.describeError(new GotifyHttpError("boom", 403))).toBe("gotify server responded with HTTP status 403")
    expect(adapter.describeError(new Error("foreign detail"))).toBe(describeGotifyError(new Error("foreign detail")))
  })
})
