import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  ConfigError,
  loadConfigFile,
  normalizeConfig,
  normalizeServerUrl,
  parseConfigText,
  resolveConfigFilePath,
} from "../src/config.js"
import {
  MAX_REFERENCED_FILE_BYTES,
  DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  notificationKinds,
  type GotifyPluginConfig,
  type NtfyPluginConfig,
  type PluginConfig,
  type WebPushPluginConfig,
  type WebPushSettings,
} from "../src/types.js"

// A fixed VAPID keypair for deterministic tests, generated once with
// `npx web-push generate-vapid-keys --json`. Test-only, never shipped.
const TEST_VAPID_PUBLIC_KEY = "BCbA4oS2TxtmqASPvdeQyFUoNnqMtb3uzmjouUBAkfDWsb0yR84iDS3Mrs7Pn2wconyNd_PkMKaItjHEOHv_ezs"
const TEST_VAPID_PRIVATE_KEY = "5K7qXP8V_-j1U-F8puy98fO-8q_s9m9xIdo1n4jsKpg"
// A different VAPID private key that does not match TEST_VAPID_PUBLIC_KEY.
const OTHER_VAPID_PRIVATE_KEY = "NsmwYDJcVabclF7_sx4E08qqOj7OwtOsYulrsX0xH1Q"

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-config-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function writeConfig(text: string, dir: string): Promise<string> {
  const dirName = join(dir, "opencode")
  await mkdir(dirName, { recursive: true })
  const filePath = join(dirName, "notification-notifications-with-questions.json")
  await writeFile(filePath, text, "utf8")
  return filePath
}

/** Resolves a rejected promise to its error for message assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the promise to reject")
}
/** Captures the error thrown by a synchronous function for message assertions. */
function thrownErrorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the function to throw")
}
/** Narrows a validated config to the ntfy variant these tests assert on. */
function asNtfy(config: PluginConfig): NtfyPluginConfig {
  if (config.transport !== "ntfy") throw new Error("expected an active ntfy Transport")
  return config
}
/** Narrows a validated config to the gotify variant these tests assert on. */
function asGotify(config: PluginConfig): GotifyPluginConfig {
  if (config.transport !== "gotify") throw new Error("expected an active gotify Transport")
  return config
}
/** Narrows a validated config to the webpush variant these tests assert on. */
function asWebpush(config: PluginConfig): WebPushPluginConfig {
  if (config.transport !== "webpush") throw new Error("expected an active webpush Transport")
  return config
}

/** A raw valid webpush transport config with overridable webpush fields. */
function webpushConfig(overrides: Partial<WebPushSettings> = {}): Record<string, unknown> {
  return {
    transport: "webpush",
    webpush: {
      subject: "mailto:push@example.com",
      publicKey: TEST_VAPID_PUBLIC_KEY,
      privateKey: TEST_VAPID_PRIVATE_KEY,
      storePath: "/tmp/opencode/subscriptions.json",
      ...overrides,
    },
  }
}

describe("config file path", () => {
  it("uses $XDG_CONFIG_HOME when set", () => {
    expect(resolveConfigFilePath({ XDG_CONFIG_HOME: "/custom/config" }, "/home/tester")).toBe(
      join("/custom/config", "opencode", "notification-notifications-with-questions.json"),
    )
  })

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", () => {
    const expected = join("/home/tester", ".config", "opencode", "notification-notifications-with-questions.json")
    expect(resolveConfigFilePath({}, "/home/tester")).toBe(expected)
    expect(resolveConfigFilePath({ XDG_CONFIG_HOME: "" }, "/home/tester")).toBe(expected)
  })
})

describe("loadConfigFile", () => {
  it("fails with an actionable error when the config file is missing", async () => {
    const dir = await makeDir()
    const missing = join(dir, "opencode", "notification-notifications-with-questions.json")
    const error = await rejectionOf(loadConfigFile(missing))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe("config.unreadable")
    expect(error.message).toMatch(/config file not found/)
    expect(error.message).toContain(missing)
  })

  it("loads a minimal config with defaults applied", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "my-topic" } }), dir)
    const config = asNtfy(await loadConfigFile(filePath))
    expect(config.enabled).toBe(true)
    for (const kind of notificationKinds) expect(config.events[kind]).toBe(true)
    expect(config.suppressSubagents).toEqual({ "session.idle": true, "session.error": true })
    expect(config.permissionNotificationDelayMs).toBe(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS)
    expect(config.ntfy.server).toBe("https://ntfy.sh/")
    expect(config.ntfy.topic).toBe("my-topic")
    expect(config.ntfy.priority).toBe("default")
    expect(config.ntfy.timeoutMs).toBe(5000)
    expect(config.ntfy.token).toBeUndefined()
  })

  it("rejects invalid JSON and never echoes the file content", async () => {
    const dir = await makeDir()
    // Deliberately invalid JSON that still contains a secret-looking value.
    const filePath = await writeConfig('{"ntfy":{"topic":"sup3rs3cret-content"', dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe("config.invalidJson")
    expect(error.message).toMatch(/not valid JSON/)
    expect(error.message).not.toContain("sup3rs3cret-content")
  })
})

describe("validation", () => {
  it("accepts a complete config", () => {
    const raw = {
      $schema: "https://example.invalid/schema.json",
      enabled: true,
      events: { "session.idle": true, "session.error": false, "permission.asked": true, "question.asked": false },
      suppressSubagents: { "session.idle": false, "session.error": true },
      permissionNotificationDelayMs: 300000,
      ntfy: {
        server: "https://ntfy.example.com/prefix",
        topic: "opencode_alerts-1",
        token: "tk_123",
        priority: "high",
        timeoutMs: 30000,
      },
    }
    const config = asNtfy(normalizeConfig(raw))
    expect(config.ntfy.server).toBe("https://ntfy.example.com/prefix/")
    expect(config.events["session.error"]).toBe(false)
    expect(config.suppressSubagents["session.idle"]).toBe(false)
    expect(config.ntfy.priority).toBe("high")
    expect(config.permissionNotificationDelayMs).toBe(300000)
  })

  it("accepts permissionNotificationDelayMs 0 (immediate) and the maximum", () => {
    expect(normalizeConfig({ permissionNotificationDelayMs: 0, ntfy: { topic: "t" } }).permissionNotificationDelayMs).toBe(0)
    expect(
      normalizeConfig({ permissionNotificationDelayMs: 300000, ntfy: { topic: "t" } }).permissionNotificationDelayMs,
    ).toBe(300000)
  })

  const invalidCases: Array<[string, unknown, RegExp]> = [
    ["non-object top level", [1, 2], /top level/],
    ["unknown top-level key", { unknownKey: true, ntfy: { topic: "t" } }, /unknown top-level property "unknownKey"/],
    ["events not object", { events: true, ntfy: { topic: "t" } }, /"events" must be an object/],
    ["unknown event key", { events: { "session.bogus": true }, ntfy: { topic: "t" } }, /"events.session.bogus"/],
    ["non-boolean event value", { events: { "session.idle": "yes" }, ntfy: { topic: "t" } }, /must be a boolean/],
    [
      "suppressSubagents unknown key",
      { suppressSubagents: { "permission.asked": false }, ntfy: { topic: "t" } },
      /not a supported property/,
    ],
    ["suppressSubagents non boolean", { suppressSubagents: { "session.idle": 1 }, ntfy: { topic: "t" } }, /must be a boolean/],
    ["missing ntfy", {}, /required property "ntfy" is missing/],
    ["ntfy not object", { ntfy: "nope" }, /"ntfy" must be an object/],
    ["ntfy unknown key", { ntfy: { topic: "t", secret: "x" } }, /"ntfy.secret"/],
    ["missing topic", { ntfy: {} }, /required property "ntfy.topic"/],
    ["empty topic", { ntfy: { topic: "" } }, /"ntfy.topic"/],
    ["topic with space", { ntfy: { topic: "a b" } }, /"ntfy.topic"/],
    ["topic too long", { ntfy: { topic: "x".repeat(65) } }, /"ntfy.topic"/],
    ["non-string topic", { ntfy: { topic: 7 } }, /required property "ntfy.topic"/],
    ["server not http", { ntfy: { topic: "t", server: "ftp://ntfy.sh" } }, /http/],
    ["server with credentials", { ntfy: { topic: "t", server: "https://user:pass@ntfy.sh" } }, /credentials/],
    ["server with query", { ntfy: { topic: "t", server: "https://ntfy.sh/?a=b" } }, /query string/],
    ["server with empty query delimiter", { ntfy: { topic: "t", server: "https://x.test/?" } }, /query string/],
    ["server with fragment", { ntfy: { topic: "t", server: "https://ntfy.sh/#frag" } }, /fragment/],
    ["server with empty fragment delimiter", { ntfy: { topic: "t", server: "https://x.test/#" } }, /fragment/],
    ["server with whitespace", { ntfy: { topic: "t", server: "https://x.test /x" } }, /must not contain whitespace/],
    ["server with bare percent host", { ntfy: { topic: "t", server: "https://%/" } }, /not a valid URL/],
    ["server with invalid port", { ntfy: { topic: "t", server: "https://x.test:abc" } }, /not a valid URL/],
    ["server out of range port", { ntfy: { topic: "t", server: "https://x.test:99999" } }, /not a valid URL/],
    ["non-string server", { ntfy: { topic: "t", server: 42 } }, /must be a non-empty string/],
    ["token not a string", { ntfy: { topic: "t", token: 42 } }, /"ntfy.token"/],
    ["token empty", { ntfy: { topic: "t", token: "" } }, /"ntfy.token"/],
    ["invalid priority", { ntfy: { topic: "t", priority: "urgent" } }, /priority/],
    ["timeout not a number", { ntfy: { topic: "t", timeoutMs: "soon" } }, /timeoutMs/],
    ["timeout non-integer", { ntfy: { topic: "t", timeoutMs: 1.5 } }, /timeoutMs/],
    ["timeout too small", { ntfy: { topic: "t", timeoutMs: 0 } }, /timeoutMs.*between 1 and 60000/],
    ["timeout negative", { ntfy: { topic: "t", timeoutMs: -5 } }, /timeoutMs/],
    ["timeout too large", { ntfy: { topic: "t", timeoutMs: 60001 } }, /timeoutMs.*between 1 and 60000/],
    [
      "permissionNotificationDelayMs fractional",
      { permissionNotificationDelayMs: 1.5, ntfy: { topic: "t" } },
      /permissionNotificationDelayMs/,
    ],
    [
      "permissionNotificationDelayMs negative",
      { permissionNotificationDelayMs: -1, ntfy: { topic: "t" } },
      /permissionNotificationDelayMs/,
    ],
    [
      "permissionNotificationDelayMs over maximum",
      { permissionNotificationDelayMs: 300001, ntfy: { topic: "t" } },
      /permissionNotificationDelayMs.*between 0 and 300000/,
    ],
    [
      "permissionNotificationDelayMs not a number",
      { permissionNotificationDelayMs: "15000", ntfy: { topic: "t" } },
      /permissionNotificationDelayMs/,
    ],
    [
      "permissionNotificationDelayMs boolean",
      { permissionNotificationDelayMs: true, ntfy: { topic: "t" } },
      /permissionNotificationDelayMs/,
    ],
    ["enabled not boolean", { enabled: "yes", ntfy: { topic: "t" } }, /"enabled"/],
  ]

  for (const [name, raw, pattern] of invalidCases) {
    it(`rejects: ${name}`, () => {
      expect(() => normalizeConfig(raw)).toThrow(pattern)
    })
  }
})

describe("size limits", () => {
  it("rejects a config file larger than 64 KiB without leaking content", async () => {
    const dir = await makeDir()
    const big = JSON.stringify({ ntfy: { topic: "t" }, padding: "x".repeat(70 * 1024) })
    const filePath = await writeConfig(big, dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.tooLarge")
    expect(error.message).not.toContain("x".repeat(20))
  })

  it("rejects referenced files larger than 16 KiB without leaking content", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: "{file:secret.txt}" } }), dir)
    const secret = join(dir, "opencode", "secret.txt")
    await writeFile(secret, "x".repeat(MAX_REFERENCED_FILE_BYTES + 1), "utf8")
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.fileTooLarge")
    expect(error.message).toContain("secret.txt")
    expect(error.message).not.toContain("x".repeat(20))
  })

  it("rejects environment values larger than 16 KiB, naming variable and limit only", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_HUGE}" } }
    const error = await rejectionOf(
      parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_HUGE: "e".repeat(MAX_REFERENCED_FILE_BYTES + 1) } }),
    )
    expect((error as ConfigError).code).toBe("config.envTooLarge")
    expect(error.message).toContain("NTFY_HUGE")
    expect(error.message).not.toContain("eee")
  })

  it("rejects aggregate expanded configs larger than 64 KiB without leaking content", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(
      JSON.stringify({
        a: "{file:blob-0.txt}",
        b: "{file:blob-1.txt}",
        c: "{file:blob-2.txt}",
        d: "{file:blob-3.txt}",
        e: "{file:blob-4.txt}",
      }),
      dir,
    )
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(dir, "opencode", `blob-${i}.txt`), "b".repeat(MAX_REFERENCED_FILE_BYTES), "utf8")
    }
    const error = await rejectionOf(loadConfigFile(filePath))
    expect((error as ConfigError).code).toBe("config.expandedTooLarge")
    expect(error.message).not.toContain("bbb")
  })
})

describe("token substitution", () => {
  it("substitutes {env:VAR} from the provided environment", async () => {
    const raw = { ntfy: { topic: "{env:NTFY_TOPIC}", token: "{env:NTFY_TOKEN}" } }
    const config = asNtfy(await parseConfigText(JSON.stringify(raw), {
      dir: "/tmp",
      env: { NTFY_TOPIC: "env-topic", NTFY_TOKEN: "env-token" },
    }))
    expect(config.ntfy.topic).toBe("env-topic")
    expect(config.ntfy.token).toBe("env-token")
  })

  it("fails on a missing environment variable, naming only the variable", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_MISSING_TOKEN}" } }
    const error = await rejectionOf(parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { OTHER: "value" } }))
    expect(error.message).toMatch(/environment variable "NTFY_MISSING_TOKEN"/)
    expect(error.message).not.toMatch(/value/)
  })

  it("fails on an empty environment variable value", async () => {
    const raw = { ntfy: { topic: "t", token: "{env:NTFY_EMPTY}" } }
    const error = await rejectionOf(parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_EMPTY: "" } }))
    expect((error as ConfigError).code).toBe("config.envUnset")
  })

  it("never includes substituted values in validation errors", async () => {
    const raw = { ntfy: { topic: "ok-topic", token: "{env:NTFY_HUSH}" }, unknownField: true }
    const error = await rejectionOf(
      parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { NTFY_HUSH: "sup3rs3cret" } }),
    )
    expect(error.message).toContain("unknownField")
    expect(error.message).not.toContain("sup3rs3cret")
  })

  it("substitutes {file:path} relative to the config directory", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "{file:topic.txt}" } }), dir)
    await writeFile(join(dir, "opencode", "topic.txt"), "file-topic\n", "utf8")
    const config = asNtfy(await loadConfigFile(filePath))
    expect(config.ntfy.topic).toBe("file-topic")
  })

  it("supports absolute file paths", async () => {
    const dir = await makeDir()
    const secret = join(dir, "abs-secret.txt")
    await writeFile(secret, "  abs-token  ", "utf8")
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: `{file:${secret}}` } }), dir)
    const config = asNtfy(await loadConfigFile(filePath))
    expect(config.ntfy.token).toBe("abs-token")
  })

  it("supports ~/ file paths resolved against the home directory", async () => {
    const dir = await makeDir()
    const home = join(dir, "home")
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "tilde-token.txt"), "tilde-token", "utf8")
    const config = asNtfy(await parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:~/tilde-token.txt}" } }), {
      dir,
      home,
    }))
    expect(config.ntfy.token).toBe("tilde-token")
  })

  it("fails when a referenced file is missing, naming only the path", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(JSON.stringify({ ntfy: { topic: "t", token: "{file:missing.txt}" } }), dir)
    const error = await rejectionOf(loadConfigFile(filePath))
    expect(error.message).toContain("missing.txt")
    expect((error as ConfigError).code).toBe("config.fileUnreadable")
  })

  it("recurses through nested structures before validation", async () => {
    const config = asNtfy(
      await parseConfigText(
        JSON.stringify({
          $schema: "{env:NTFY_SCHEMA}",
          ntfy: { topic: "{env:NTFY_TOPIC}", server: "{env:NTFY_SERVER}" },
          events: { "session.idle": true },
        }),
        {
          dir: "/tmp",
          env: { NTFY_SCHEMA: "https://example.invalid/s.json", NTFY_TOPIC: "nested-topic", NTFY_SERVER: "https://ntfy.example.com" },
        },
      ),
    )
    expect(config.ntfy.topic).toBe("nested-topic")
    expect(config.ntfy.server).toBe("https://ntfy.example.com/")
  })

  it("does not rescan substituted content for further tokens", async () => {
    const dir = await makeDir()
    await writeFile(join(dir, "payload.txt"), "{env:NTFY_SHOULD_NOT_EXPAND}", "utf8")
    const config = asNtfy(await parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:payload.txt}" } }), {
      dir,
      env: {},
    }))
    expect(config.ntfy.token).toBe("{env:NTFY_SHOULD_NOT_EXPAND}")
  })

  it("rejects references embedded in surrounding text", async () => {
    const badValues = [
      "{env:NTFY_TOPIC}-suffix",
      "prefix-{env:NTFY_TOPIC}",
      "{env:NTFY_A}{env:NTFY_B}",
      "{file:topic.txt}/extra",
    ]
    for (const value of badValues) {
      const error = await rejectionOf(
        parseConfigText(JSON.stringify({ ntfy: { topic: value } }), { dir: "/tmp", env: { NTFY_TOPIC: "t" } }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).toContain("entire string value")
    }
  })

  it("rejects empty, whitespace-only and malformed references", async () => {
    const badValues = ["{env:}", "{env:   }", "{file:}", "{file:   }", "{env:a{b}", "{file:a}b", "{env:}x", "{env:}x", "{{env:A}}"]
    for (const value of badValues) {
      const error = await rejectionOf(
        parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: value } }), { dir: "/tmp", env: {} }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).not.toContain(value)
    }
  })

  it("keeps ordinary strings with unrelated braces as literals", async () => {
    const config = asNtfy(
      await parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "abc{x}y{z}" } }), { dir: "/tmp" }),
    )
    expect(config.ntfy.token).toBe("abc{x}y{z}")
  })
})

describe("normalizeServerUrl", () => {
  it("keeps a reverse-proxy path prefix and adds one trailing slash", () => {
    expect(normalizeServerUrl("https://ntfy.example.com/notify")).toBe("https://ntfy.example.com/notify/")
    expect(normalizeServerUrl("https://ntfy.example.com/notify/")).toBe("https://ntfy.example.com/notify/")
    expect(normalizeServerUrl("https://ntfy.example.com/a///")).toBe("https://ntfy.example.com/a/")
  })

  it("preserves an explicit port", () => {
    expect(normalizeServerUrl("http://localhost:8090")).toBe("http://localhost:8090/")
  })

  it("rejects raw whitespace and empty query/fragment delimiters", () => {
    expect(() => normalizeServerUrl("https://x.test /x")).toThrow(/must not contain whitespace/)
    expect(() => normalizeServerUrl("https://x.test\t")).toThrow(/must not contain whitespace/)
    expect(() => normalizeServerUrl("https://x.test/?")).toThrow(/query string/)
    expect(() => normalizeServerUrl("https://x.test/#")).toThrow(/fragment/)
  })

  it("rejects malformed hosts and ports", () => {
    expect(() => normalizeServerUrl("https://%/")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:abc")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:65536")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://")).toThrow(/not a valid URL|include a host/)
  })

  it("rejects raw syntax that a lenient URL parser would accept", () => {
    // Triple-slash authorities are folded into a path by new URL.
    expect(() => normalizeServerUrl("http:///ntfy.example.com")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https:///x.test")).toThrow(/not a valid URL/)
    // Zero-padded ports are silently dropped by new URL.
    expect(() => normalizeServerUrl("https://x.test:080")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test:00080")).toThrow(/not a valid URL/)
    // Percent-encoded host characters are not host syntax.
    expect(() => normalizeServerUrl("http://foo%20bar.test")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("http://foo%23bar.test")).toThrow(/not a valid URL/)
  })

  it("accepts canonical ports, encoded paths and IPv6", () => {
    expect(normalizeServerUrl("https://x.test:0/")).toBe("https://x.test:0/")
    expect(normalizeServerUrl("https://x.test:65535")).toBe("https://x.test:65535/")
    expect(normalizeServerUrl("https://ntfy.example.com/a%20b")).toBe("https://ntfy.example.com/a%20b/")
    expect(normalizeServerUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/")
  })

  it("accepts nested and percent-encoded path segments", () => {
    expect(normalizeServerUrl("https://x.test/")).toBe("https://x.test/")
    expect(normalizeServerUrl("https://x.test/a/b")).toBe("https://x.test/a/b/")
    expect(normalizeServerUrl("https://x.test/%20/%23/%3F")).toBe("https://x.test/%20/%23/%3F/")
    expect(normalizeServerUrl("https://x.test/%C3%A9/na%C3%AFve")).toBe("https://x.test/%C3%A9/na%C3%AFve/")
  })

  it("rejects malformed percent escapes and raw path characters", () => {
    expect(() => normalizeServerUrl("https://x.test/%")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/%2")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/%GG")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a{b}")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a\\b")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/a[b]")).toThrow(/not a valid URL/)
    expect(() => normalizeServerUrl("https://x.test/\u017c")).toThrow(/not a valid URL/)
  })

  it("accepts localhost and IPv6 literals", () => {
    expect(normalizeServerUrl("http://localhost:8090")).toBe("http://localhost:8090/")
    expect(normalizeServerUrl("http://[::1]:8090")).toBe("http://[::1]:8090/")
    expect(normalizeServerUrl("https://[2001:db8::1]/prefix")).toBe("https://[2001:db8::1]/prefix/")
  })

  it("rejects malformed or all-numeric hosts", () => {
    const badHosts = [
      "http://256.256.256.256",
      "http://256.0.0.1",
      "http://1.2.3.4.5",
      "http://4294967296",
      "http://99999999999",
      "http://01.2.3.4",
    ]
    for (const server of badHosts) {
      expect(() => normalizeServerUrl(server)).toThrow(/not a valid URL/)
    }
  })

  it("accepts canonical IPv4 and numeric-prefixed DNS names", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090/")
    expect(normalizeServerUrl("http://123.example")).toBe("http://123.example/")
    expect(normalizeServerUrl("http://123-example")).toBe("http://123-example/")
  })
})
describe("transport selection", () => {
  it("defaults the transport to ntfy when the key is absent", () => {
    expect(normalizeConfig({ ntfy: { topic: "t" } }).transport).toBe("ntfy")
  })

  it("accepts transport ntfy and produces the same config as the absent key", () => {
    const withKey = normalizeConfig({ transport: "ntfy", ntfy: { topic: "t" } })
    expect(withKey).toEqual(normalizeConfig({ ntfy: { topic: "t" } }))
  })

  it("accepts the supported transport name gotify", () => {
    const config = normalizeConfig({
      transport: "gotify",
      gotify: { server: "https://gotify.example.com/", token: "gotify-app-token" },
    })
    expect(config.transport).toBe("gotify")
  })

  it("accepts transport webpush without an ntfy section", () => {
    const config = normalizeConfig(webpushConfig())
    expect(config.transport).toBe("webpush")
    const webpush = asWebpush(config).webpush
    expect(webpush.subject).toBe("mailto:push@example.com")
    expect(webpush.publicKey).toBe(TEST_VAPID_PUBLIC_KEY)
    expect(webpush.privateKey).toBe(TEST_VAPID_PRIVATE_KEY)
    expect(webpush.storePath).toBe("/tmp/opencode/subscriptions.json")
    expect(webpush.timeoutMs).toBe(5000)
  })

  it("accepts an explicit webpush timeoutMs within bounds", () => {
    const config = normalizeConfig(webpushConfig({ timeoutMs: 30000 }))
    expect(asWebpush(config).webpush.timeoutMs).toBe(30000)
  })

  it("rejects unknown transport values without echoing them", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "banana", ntfy: { topic: "t" } }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"transport" must be one of ntfy, gotify, webpush')
    expect(error.message).not.toContain("banana")
  })

  it("rejects non-string transport values", () => {
    for (const value of [42, true, null, { ntfy: {} }]) {
      expect(() => normalizeConfig({ transport: value, ntfy: { topic: "t" } })).toThrow(ConfigError)
      expect(() => normalizeConfig({ transport: value, ntfy: { topic: "t" } })).toThrow(/"transport"/)
    }
  })

  it("rejects a substituted transport value without echoing unrecognized content", async () => {
    // Substitution runs before validation: an {env:} reference that expands to
    // an unknown value must fail without leaking the expanded value.
    const error = await rejectionOf(
      parseConfigText(JSON.stringify({ transport: "{env:T}", ntfy: { topic: "t" } }), { dir: "/tmp", env: { T: "banana" } }),
    )
    expect(error.message).toContain('"transport" must be one of ntfy, gotify, webpush')
    expect(error.message).not.toContain("banana")
  })

  it("accepts a substituted transport value that names the gotify Transport", async () => {
    const config = asGotify(
      await parseConfigText(
        JSON.stringify({
          transport: "{env:T}",
          gotify: { server: "https://gotify.example.com/", token: "{env:GOTIFY_TOKEN}" },
        }),
        { dir: "/tmp", env: { T: "gotify", GOTIFY_TOKEN: "tok_env_token" } },
      ),
    )
    expect(config.transport).toBe("gotify")
    expect(config.gotify.token).toBe("tok_env_token")
  })
})
describe("inactive transport sections", () => {
  it("rejects a non-empty section of an inactive Transport as a misconfiguration", () => {
    const error = thrownErrorOf(() =>
      normalizeConfig({ ntfy: { topic: "t" }, gotify: { server: "https://gotify.example.com", token: "super-secret-token" } }),
    )
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"gotify"')
    expect(error.message).toContain('"transport"')
    expect(error.message).toContain("ntfy")
  })

  it("never echoes settings from a rejected inactive section", () => {
    const error = thrownErrorOf(() => normalizeConfig({ ntfy: { topic: "t" }, webpush: { subject: "mailto:me@example.com" } }))
    expect(error.message).toContain('"webpush"')
    expect(error.message).not.toContain("me@example.com")
    expect(error.message).not.toContain("mailto")
  })

  it("accepts an empty inactive section", () => {
    const config = asNtfy(normalizeConfig({ ntfy: { topic: "t" }, gotify: {}, webpush: {} }))
    expect(config.transport).toBe("ntfy")
    expect(config.ntfy.topic).toBe("t")
  })

  it("rejects a non-object inactive section", () => {
    for (const section of [42, "gotify", true, []]) {
      expect(() => normalizeConfig({ ntfy: { topic: "t" }, gotify: section })).toThrow(/"gotify" must be an object/)
    }
  })
})

describe("gotify transport section", () => {
  const baseGotify = { server: "https://gotify.example.com/", token: "gotify-app-token" }

  it("accepts a strictly validated gotify section and does not build an ntfy section", () => {
    const config = normalizeConfig({
      transport: "gotify",
      gotify: { ...baseGotify, priority: "high", timeoutMs: 2500 },
    })
    expect(config.transport).toBe("gotify")
    expect(config).toEqual({
      enabled: true,
      events: {
        "session.idle": true,
        "session.error": true,
        "permission.asked": true,
        "question.asked": true,
        "agent.notify": true,
      },
      suppressSubagents: { "session.idle": true, "session.error": true },
      permissionNotificationDelayMs: DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS,
      agentNotifyTools: ["opencode_notify", "openchamber_notify"],
      enrichIdleMessages: true,
      transport: "gotify",
      gotify: { server: "https://gotify.example.com/", token: "gotify-app-token", priority: "high", timeoutMs: 2500 },
    })
  })

  it("applies the gotify defaults", () => {
    const config = asGotify(normalizeConfig({ transport: "gotify", gotify: baseGotify }))
    expect(config.gotify.priority).toBe("default")
    expect(config.gotify.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it("normalizes the gotify server URL with exactly one trailing slash, like the ntfy server", () => {
    const config = asGotify(normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, server: "https://gotify.example.com/prefix" } }))
    expect(config.gotify.server).toBe("https://gotify.example.com/prefix/")
  })

  it("rejects a missing gotify section when transport is gotify", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify" }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('required property "gotify" is missing')
  })

  it("rejects a non-object gotify section when transport is gotify", () => {
    for (const section of [42, "gotify", true, []]) {
      expect(() => normalizeConfig({ transport: "gotify", gotify: section })).toThrow(/"gotify" must be an object/)
    }
  })

  it("rejects unknown gotify keys", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, topic: "t" } }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"gotify.topic" is not allowed')
  })

  it("rejects a missing gotify server", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { token: "t" } }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('required property "gotify.server" is missing')
  })

  it("rejects malformed gotify server URLs under the same rules as the ntfy server", () => {
    const malformed = [
      "ftp://gotify.example.com",
      "https://user:pass@gotify.example.com",
      "https://gotify.example.com/?a=b",
      "https://gotify.example.com/#frag",
      "https://gotify.example.com /x",
      "gotify.example.com",
      "",
      "https:///gotify.example.com",
      "https://x.test:00080",
      "https://x.test:65536",
      "https://x.test/%GG",
    ]
    for (const server of malformed) {
      const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, server } }))
      expect(error).toBeInstanceOf(ConfigError)
      expect(error.message).toContain('"gotify.server"')
      // Secret-safe: the offending value is never echoed.
      expect(error.message).not.toContain("ftp")
      expect(error.message).not.toContain("user:pass")
      expect(error.message).not.toContain("?a=b")
    }
  })

  it("rejects a gotify token that is missing or empty without echoing it", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { server: baseGotify.server } }))
    expect(error.message).toContain('"gotify.token"')
    // Required-field errors share one wording across the ntfy, gotify and
    // webpush sections.
    expect(error.message).toContain('required property "gotify.token" is missing or not a string')
    const empty = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, token: "" } }))
    expect(empty.message).toContain('"gotify.token"')
    expect(empty.message).not.toContain("secret")
  })

  it("rejects a non-string gotify token", () => {
    for (const token of [42, null, true, ["t"]]) {
      expect(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, token } })).toThrow(/"gotify.token"/)
    }
  })

  it("rejects an invalid gotify priority", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, priority: "urgent" } }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"gotify.priority" must be one of min, low, default, high, max')
  })

  it("rejects an out-of-range gotify timeoutMs", () => {
    for (const timeoutMs of [0, 60001, 1.5, "5000"]) {
      expect(() => normalizeConfig({ transport: "gotify", gotify: { ...baseGotify, timeoutMs } })).toThrow(/"gotify.timeoutMs"/)
    }
  })

  it("rejects a non-empty ntfy section when transport is gotify", () => {
    const error = thrownErrorOf(() =>
      normalizeConfig({ transport: "gotify", gotify: baseGotify, ntfy: { topic: "demo-topic" } }),
    )
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"ntfy"')
    expect(error.message).toContain('"gotify"')
    // The inactive section's settings are never echoed.
    expect(error.message).not.toContain("topic")
    expect(error.message).not.toContain("demo-topic")
  })

  it("accepts an empty ntfy section when transport is gotify", () => {
    const config = asGotify(normalizeConfig({ transport: "gotify", gotify: baseGotify, ntfy: {} }))
    expect(config.transport).toBe("gotify")
    expect(config.gotify.server).toBe(baseGotify.server)
  })
})

describe("webpush transport section", () => {
  it("rejects transport webpush without a webpush section", () => {
    const error = thrownErrorOf(() => normalizeConfig({ transport: "webpush" }))
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.message).toContain('"webpush"')
    expect(error.message).toContain("required")
  })

  it("rejects a non-object webpush section", () => {
    for (const section of [42, "webpush", true, []]) {
      expect(() => normalizeConfig({ transport: "webpush", webpush: section })).toThrow(/"webpush" must be an object/)
    }
  })

  it("rejects unknown webpush keys", () => {
    const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ extra: "x" } as Partial<WebPushSettings>)))
    expect(error.message).toContain('"webpush.extra" is not allowed')
  })

  it("rejects an invalid subject without echoing it", () => {
    for (const subject of [undefined, 42, "", "push@example.com", "http://plain.example.com", "ftp://files.example.com", "mailto:"]) {
      const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ subject: subject as string })))
      expect(error.message).toContain('"webpush.subject"')
    }
  })

  it("rejects an invalid public key", () => {
    for (const publicKey of [undefined, 42, "", "abc", "B".repeat(64), Buffer.alloc(65, 3).toString("base64url")]) {
      const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ publicKey: publicKey as string })))
      expect(error.message).toContain('"webpush.publicKey"')
    }
    // A missing key is worded like the other required-field errors.
    const missing = thrownErrorOf(() => normalizeConfig(webpushConfig({ publicKey: undefined })))
    expect(missing.message).toContain('required property "webpush.publicKey" is missing or not a string')
  })

  it("rejects an invalid private key", () => {
    for (const privateKey of [undefined, 42, "", "abc", Buffer.alloc(31).toString("base64url"), Buffer.alloc(33).toString("base64url")]) {
      const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ privateKey: privateKey as string })))
      expect(error.message).toContain('"webpush.privateKey"')
    }
    // A missing key is worded like the other required-field errors.
    const missing = thrownErrorOf(() => normalizeConfig(webpushConfig({ privateKey: undefined })))
    expect(missing.message).toContain('required property "webpush.privateKey" is missing or not a string')
  })

  it("never echoes the private key value in validation errors", () => {
    const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ privateKey: "!!!not-a-key!!!" })))
    expect(error.message).not.toContain("!!!")
  })

  it("rejects a keypair whose private key does not match the public key", () => {
    const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ privateKey: OTHER_VAPID_PRIVATE_KEY })))
    expect(error.message).toContain('"webpush.privateKey"')
    expect(error.message).not.toContain(OTHER_VAPID_PRIVATE_KEY)
    expect(error.message).not.toContain(TEST_VAPID_PUBLIC_KEY)
  })

  it("rejects a missing or empty storePath", () => {
    for (const storePath of [undefined, 42, "", "   "]) {
      const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ storePath: storePath as string })))
      expect(error.message).toContain('"webpush.storePath"')
    }
  })

  it("rejects an invalid webpush timeoutMs", () => {
    for (const timeoutMs of [0, 60001, 1.5, -5, "soon"]) {
      const error = thrownErrorOf(() => normalizeConfig(webpushConfig({ timeoutMs: timeoutMs as number })))
      expect(error.message).toMatch(/"webpush\.timeoutMs"/)
    }
  })

  it("rejects a non-empty ntfy section when webpush is active", () => {
    const error = thrownErrorOf(() =>
      normalizeConfig({ ...webpushConfig(), ntfy: { topic: "t", token: "super-secret-token" } }),
    )
    expect(error.message).toContain('"ntfy"')
    expect(error.message).toContain('"transport"')
    expect(error.message).not.toContain("super-secret-token")
  })

  it("rejects a non-empty gotify section when webpush is active", () => {
    const error = thrownErrorOf(() =>
      normalizeConfig({ ...webpushConfig(), gotify: { server: "https://gotify.example.com", token: "super-secret-token" } }),
    )
    expect(error.message).toContain('"gotify"')
    expect(error.message).toContain('"transport"')
    expect(error.message).not.toContain("super-secret-token")
  })

  it("rejects a non-object ntfy section when webpush is active", () => {
    for (const section of [42, "nope", true, []]) {
      expect(() => normalizeConfig({ transport: "webpush", webpush: validWebpushSection(), ntfy: section })).toThrow(
        /"ntfy" must be an object/,
      )
    }
  })

  it("accepts an empty ntfy and gotify section when webpush is active", () => {
    const config = normalizeConfig({ ...webpushConfig(), ntfy: {}, gotify: {} })
    expect(config.transport).toBe("webpush")
    expect(asWebpush(config).webpush.storePath).toBe("/tmp/opencode/subscriptions.json")
  })

  it("substitutes the VAPID private key from an environment variable", async () => {
    const raw = { transport: "webpush", webpush: { ...validWebpushSection(), privateKey: "{env:VAPID_PRIVATE_KEY}" } }
    const config = await parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY } })
    expect(config.transport).toBe("webpush")
    expect(asWebpush(config).webpush.privateKey).toBe(TEST_VAPID_PRIVATE_KEY)
  })

  it("substitutes the VAPID private key from a file", async () => {
    const dir = await makeDir()
    const configDir = join(dir, "opencode")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "vapid-private.txt"), `${TEST_VAPID_PRIVATE_KEY}\n`, "utf8")
    const raw = { transport: "webpush", webpush: { ...validWebpushSection(), privateKey: "{file:vapid-private.txt}" } }
    const config = await parseConfigText(JSON.stringify(raw), { dir: configDir, env: {} })
    expect(asWebpush(config).webpush.privateKey).toBe(TEST_VAPID_PRIVATE_KEY)
  })

  it("fails on an unset private key variable, naming only the variable", async () => {
    const raw = { transport: "webpush", webpush: { ...validWebpushSection(), privateKey: "{env:VAPID_MISSING}" } }
    const error = await rejectionOf(parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: {} }))
    expect(error.message).toMatch(/environment variable "VAPID_MISSING"/)
    expect(error.message).not.toContain("privateKey value")
  })

  function validWebpushSection(): Record<string, string> {
    return {
      subject: "mailto:push@example.com",
      publicKey: TEST_VAPID_PUBLIC_KEY,
      privateKey: TEST_VAPID_PRIVATE_KEY,
      storePath: "/tmp/opencode/subscriptions.json",
    }
  }
})

