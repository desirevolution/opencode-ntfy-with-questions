import { describe, expect, it, vi } from "vitest"
import { createGotifyClient, describeGotifyError, GotifyHttpError, GotifyTimeoutError, GotifyTransportError } from "../src/gotify-client.js"
import { notificationKinds, type GotifySettings, type NotificationKind } from "../src/types.js"

function settings(overrides: Partial<GotifySettings> = {}): GotifySettings {
  return {
    server: "https://gotify.example.com/",
    token: "Aa1ExampleToken",
    priority: "default",
    timeoutMs: 5000,
    ...overrides,
  }
}

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } })
}

type MockFetch = ReturnType<typeof vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>>
function okFetch(): MockFetch {
  return vi.fn(async () => jsonResponse(200))
}
function requestOf(fetchMock: MockFetch): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url, init }
}

describe("publish request construction", () => {
  it("POSTs JSON to the server's message endpoint with the app token in a header", async () => {
    const fetchMock = okFetch()
    const client = createGotifyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "Hello", message: "World" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://gotify.example.com/message")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("Aa1ExampleToken")
    // The token travels in the header, never the URL.
    expect(url).not.toContain("Aa1ExampleToken")
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ title: "Hello", message: "World", priority: 4 })
    expect(typeof body.priority).toBe("number")
  })

  it("keeps a self-hosted reverse-proxy path prefix in front of /message", async () => {
    const fetchMock = okFetch()
    const client = createGotifyClient(
      settings({ server: "https://gotify.example.com/push/", priority: "high" }),
      { fetch: fetchMock as unknown as typeof fetch },
    )
    await client.publish({ title: "T", message: "M" })
    const { url, init } = requestOf(fetchMock)
    expect(url).toBe("https://gotify.example.com/push/message")
    const body = JSON.parse(String(init.body))
    expect(body.priority).toBe(8)
    expect(typeof body.priority).toBe("number")
  })

  it.each([
    ["min", 0],
    ["low", 2],
    ["default", 4],
    ["high", 8],
    ["max", 10],
  ] as const)("maps configured priority %s to the Gotify integer priority %i", async (named, level) => {
    const fetchMock = okFetch()
    const client = createGotifyClient(settings({ priority: named }), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "T", message: "M" })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body))
    expect(body.priority).toBe(level)
    expect(typeof body.priority).toBe("number")
  })

  it("lets a per-message priority override the configured one", async () => {
    const fetchMock = okFetch()
    const client = createGotifyClient(settings({ priority: "max" }), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "T", message: "M", priority: "min" })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body))
    expect(body.priority).toBe(0)
  })

  it("sends the documented request for every Notification Kind", async () => {
    for (const kind of notificationKinds) {
      const fetchMock = okFetch()
      const client = createGotifyClient(settings({ priority: "high" }), { fetch: fetchMock as unknown as typeof fetch })
      await client.publish({ title: `Title ${kind}`, message: "Body" })
      const { url, init } = requestOf(fetchMock)
      expect(url).toBe("https://gotify.example.com/message")
      expect(init.method).toBe("POST")
      expect((init.headers as Record<string, string>)["X-Gotify-Key"]).toBe("Aa1ExampleToken")
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({ title: `Title ${kind}`, message: "Body", priority: 8 })
    }
  })

  it("sanitizes the title like ntfy and preserves newlines in the message", async () => {
    const fetchMock = okFetch()
    const client = createGotifyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "Ti:tle\nnext", message: "first line\nsecond line" })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body)) as { title: string; message: string }
    expect(body.title).toBe("Ti:tle next")
    expect(body.message).toBe("first line\nsecond line")
  })

  it("truncates the title to 1024 bytes and the message to 4096 bytes", async () => {
    const fetchMock = okFetch()
    const client = createGotifyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await client.publish({ title: "t".repeat(5000), message: "m".repeat(10_000) })
    const { init } = requestOf(fetchMock)
    const body = JSON.parse(String(init.body)) as { title: string; message: string }
    expect(Buffer.byteLength(body.title, "utf8")).toBeLessThanOrEqual(1024)
    expect(Buffer.byteLength(body.message, "utf8")).toBeLessThanOrEqual(4096)
  })
})

describe("publish failures", () => {
  it("rejects with the HTTP status for non-2xx responses", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403))
    const client = createGotifyClient(settings(), { fetch: fetchMock as unknown as typeof fetch })
    await expect(client.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyHttpError)
    await expect(client.publish({ title: "T", message: "M" })).rejects.toThrow(/HTTP status 403/)
  })

  it("never leaks the token or payload in HTTP errors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401))
    const client = createGotifyClient(settings({ token: "tk_secret_value" }), { fetch: fetchMock as unknown as typeof fetch })
    try {
      await client.publish({ title: "Secret title", message: "Secret message" })
      expect.unreachable("publish should have rejected")
    } catch (error) {
      const message = describeGotifyError(error)
      expect(message).toContain("401")
      expect(message).not.toContain("tk_secret_value")
      expect(message).not.toContain("Secret title")
      expect(message).not.toContain("Secret message")
    }
  })

  it("rejects as GotifyTransportError when fetch throws or rejects", async () => {
    const throwing: MockFetch = vi.fn(() => {
      throw new TypeError("boom")
    })
    const client = createGotifyClient(settings(), { fetch: throwing as unknown as typeof fetch })
    await expect(client.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyTransportError)

    const rejecting: MockFetch = vi.fn(async () => {
      throw new TypeError("network down")
    })
    const client2 = createGotifyClient(settings(), { fetch: rejecting as unknown as typeof fetch })
    await expect(client2.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyTransportError)
  })

  it("rejects as GotifyTimeoutError when the configured timeout elapses", async () => {
    const fetchMock: MockFetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))
        })
      }),
    )
    const client = createGotifyClient(settings({ timeoutMs: 20, token: "tk_secret_value" }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    const started = Date.now()
    await expect(client.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyTimeoutError)
    await expect(client.publish({ title: "T", message: "M" })).rejects.toThrow(/timed out after 20ms/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("rejects with a typed timeout when fetch never settles and ignores its signal", async () => {
    let capturedSignal: AbortSignal | undefined
    const fetchMock: MockFetch = vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal
      return new Promise<Response>(() => {}) // never settles, ignores the signal
    })
    const client = createGotifyClient(settings({ timeoutMs: 30 }), { fetch: fetchMock as unknown as typeof fetch })
    const started = Date.now()
    await expect(client.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyTimeoutError)
    await expect(client.publish({ title: "T", message: "M" })).rejects.toThrow(/timed out after 30ms/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it("never surfaces foreign error messages or payload text", () => {
    expect(describeGotifyError(new Error("literal-token-123"))).not.toContain("literal-token-123")
    expect(describeGotifyError("literal-token-123")).toBe("unexpected gotify publish failure")
    expect(describeGotifyError(new GotifyHttpError("boom", 503))).toBe("gotify server responded with HTTP status 503")
  })

  it("never embeds thrown error names or thrown strings in transport descriptions", async () => {
    const evil = new Error("literal-token-123")
    evil.name = "literal-token-123"
    for (const factory of [
      () => {
        throw evil
      },
      () => {
        throw "literal-token-123"
      },
      async () => {
        throw evil as unknown as Error
      },
      async () => {
        throw "literal-token-123"
      },
    ]) {
      const fetchMock: MockFetch = vi.fn(factory as unknown as MockFetch)
      const client = createGotifyClient(settings({ token: "literal-token-123" }), {
        fetch: fetchMock as unknown as typeof fetch,
      })
      try {
        await client.publish({ title: "T", message: "M" })
        expect.unreachable("publish should have rejected")
      } catch (error) {
        expect(error).toBeInstanceOf(GotifyTransportError)
        expect(describeGotifyError(error)).toBe("gotify publish failed before a response was received")
        expect(describeGotifyError(error)).not.toContain("literal-token-123")
      }
    }
  })

  it("absorbs a late fetch rejection after the deadline without an unhandled rejection", async () => {
    let rejectFetch!: (reason: unknown) => void
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject
    })
    const fetchMock: MockFetch = vi.fn(() => pending)
    const client = createGotifyClient(settings({ timeoutMs: 20 }), { fetch: fetchMock as unknown as typeof fetch })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      await expect(client.publish({ title: "T", message: "M" })).rejects.toBeInstanceOf(GotifyTimeoutError)
      rejectFetch(new Error("literal-token-123"))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("kind coverage", () => {
  it("publishes without a kind-specific branch", () => {
    // Every Notification Kind carries its configured priority; the kind itself
    // never alters the wire request beyond title and message content.
    expect(notificationKinds).toEqual([
      "session.idle",
      "session.error",
      "permission.asked",
      "question.asked",
      "agent.notify",
    ] satisfies NotificationKind[])
  })
})
