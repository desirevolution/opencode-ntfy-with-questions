import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { FormatsPlugin } from "ajv-formats"
import formatsModule from "ajv-formats"
import { afterEach, describe, expect, it } from "vitest"

import { ConfigError, loadConfigFile, normalizeConfig, normalizeServerUrl, parseConfigText } from "../src/config.js"
import {
  DEFAULT_NTFY_PRIORITY,
  DEFAULT_NTFY_SERVER,
  DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSPORT,
  notificationKinds,
  type NtfyPriority,
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

function webpushSection(overrides: Partial<WebPushSettings> = {}): Record<string, unknown> {
  return {
    subject: "mailto:push@example.com",
    publicKey: TEST_VAPID_PUBLIC_KEY,
    privateKey: TEST_VAPID_PRIVATE_KEY,
    storePath: "/tmp/opencode/subscriptions.json",
    ...overrides,
  }
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

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ntfy-schema-"))
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

describe("schema parity", () => {
  const schemaPath = resolve(process.cwd(), "notification-notifications-with-questions.schema.json")
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: {
      enabled: { default: boolean }
      events: { properties: Record<string, { default: boolean }> }
      suppressSubagents: { properties: Record<string, { default: boolean }> }
      permissionNotificationDelayMs: { default: number }
      transport: { default: string }
      gotify: {
        properties: {
          priority: { default: NtfyPriority }
          timeoutMs: { default: number }
        }
      }
      webpush: {
        properties: {
          timeoutMs: { default: number }
        }
      }
      ntfy: {
        properties: {
          server: { default: string }
          priority: { default: NtfyPriority }
          timeoutMs: { default: number }
        }
      }
    }
  }
  // format: "uri" on the literal server branch is validated via ajv-formats.
  const addFormats =
    (formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin)
  const ajv = new Ajv2020({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile(schema)

  const validSamples = [
    { ntfy: { topic: "topic-a" } },
    { enabled: false, ntfy: { topic: "topic-b" } },
    { permissionNotificationDelayMs: 0, ntfy: { topic: "topic-delay-zero" } },
    { permissionNotificationDelayMs: 300000, ntfy: { topic: "topic-delay-max" } },
    { transport: "ntfy", ntfy: { topic: "topic-transport" } },
    { ntfy: { topic: "topic-reserved" }, gotify: {}, webpush: {} },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken" } },
    {
      transport: "gotify",
      gotify: { server: "https://gotify.example.com/prefix", token: "Aa1ExampleToken", priority: "high", timeoutMs: 2500 },
    },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken" }, ntfy: {} },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken" }, webpush: {} },
    { transport: "webpush", webpush: webpushSection() },
    { transport: "webpush", webpush: webpushSection({ timeoutMs: 30000 }), ntfy: {}, gotify: {} },
    {
      events: { "session.idle": true, "session.error": false },
      suppressSubagents: { "session.idle": false },
      permissionNotificationDelayMs: 15000,
      ntfy: {
        server: "https://self.ntfy.example/x",
        topic: "topic-c",
        token: "{env:NTFY_TOKEN}",
        priority: "max",
        timeoutMs: 1,
      },
    },
    { $schema: "https://example.invalid/s.json", ntfy: { topic: "t" } },
    { ntfy: { topic: "t", server: "https://ntfy.sh" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/notify/" } },
    { ntfy: { topic: "t", server: "http://localhost:8090/prefix" } },
    { ntfy: { topic: "t", server: "http://127.0.0.1:8090" } },
    { ntfy: { topic: "t", server: "http://[::1]:8090" } },
    { ntfy: { topic: "t", server: "https://[2001:db8::1]/prefix" } },
    { ntfy: { topic: "t", server: "https://x.test:65535/path" } },
    { ntfy: { topic: "t", server: "https://x.test/a%20b" } },
    { ntfy: { topic: "t", server: "http://foo_bar.test" } },
    { ntfy: { topic: "t", server: "https://x.test/a/b" } },
    { ntfy: { topic: "t", server: "https://x.test/%20/%23/%3F" } },
    { ntfy: { topic: "t", server: "https://x.test/%C3%A9/na%C3%AFve" } },
    { ntfy: { topic: "t", server: "http://123.example" } },
    { ntfy: { topic: "t", server: "http://123-example" } },
  ]

  const invalidSamples = [
    // Transport selection: only ntfy is accepted in this version.
    { transport: "gotify", ntfy: { topic: "t" } },
    // The active gotify section is strictly validated.
    { transport: "gotify" },
    { transport: "gotify", gotify: {} },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/" } },
    { transport: "gotify", gotify: { token: "Aa1ExampleToken" } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "" } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: 42 } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken", priority: "urgent" } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken", timeoutMs: 60001 } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken", timeoutMs: 1.5 } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken", topic: "t" } },
    { transport: "gotify", gotify: { server: "ftp://gotify.example.com", token: "Aa1ExampleToken" } },
    { transport: "gotify", gotify: { server: "https://user:pass@gotify.example.com", token: "Aa1ExampleToken" } },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/?a=b", token: "Aa1ExampleToken" } },
    { transport: "gotify", gotify: { server: "gotify.example.com", token: "Aa1ExampleToken" } },
    { transport: "gotify", gotify: { server: "", token: "Aa1ExampleToken" } },
    { transport: "webpush", ntfy: { topic: "t" } },
    { transport: "NTFY", ntfy: { topic: "t" } },
    // The active webpush section is strictly validated; the inactive ntfy and
    // gotify sections must stay empty while webpush is active.
    { transport: "webpush", webpush: webpushSection(), ntfy: { topic: "t" } },
    { transport: "webpush", webpush: webpushSection(), gotify: { server: "https://gotify.example.com" } },
    { transport: "webpush" },
    { transport: "webpush", webpush: {} },
    { transport: "webpush", webpush: { publicKey: TEST_VAPID_PUBLIC_KEY, privateKey: TEST_VAPID_PRIVATE_KEY, storePath: "/tmp/opencode/subscriptions.json" } },
    { transport: "webpush", webpush: webpushSection({ subject: "push@example.com" }) },
    { transport: "webpush", webpush: webpushSection({ subject: "http://plain.example.com" }) },
    { transport: "webpush", webpush: webpushSection({ publicKey: "not-base64url!" }) },
    { transport: "webpush", webpush: webpushSection({ publicKey: Buffer.alloc(64).toString("base64url") }) },
    { transport: "webpush", webpush: webpushSection({ privateKey: "not-base64url!" }) },
    { transport: "webpush", webpush: webpushSection({ privateKey: Buffer.alloc(31).toString("base64url") }) },
    { transport: "webpush", webpush: webpushSection({ storePath: "" }) },
    { transport: "webpush", webpush: { subject: "mailto:push@example.com", publicKey: TEST_VAPID_PUBLIC_KEY, privateKey: TEST_VAPID_PRIVATE_KEY } },
    { transport: "webpush", webpush: webpushSection({ timeoutMs: 0 }) },
    { transport: "webpush", webpush: webpushSection({ timeoutMs: 60001 }) },
    { transport: "webpush", webpush: { ...webpushSection(), extra: true } },
    { transport: "banana", ntfy: { topic: "t" } },
    { transport: 42, ntfy: { topic: "t" } },
    { transport: true, ntfy: { topic: "t" } },
    // Inactive Transport sections must stay empty.
    { ntfy: { topic: "t" }, gotify: { server: "https://gotify.example.com" } },
    { ntfy: { topic: "t" }, webpush: { subject: "mailto:me@example.com" } },
    { ntfy: { topic: "t" }, gotify: 42 },
    { ntfy: { topic: "t" }, webpush: [] },
    { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken" }, ntfy: { topic: "t" } },
    { ntfy: { topic: "with space" } },
    { ntfy: { topic: "t", timeoutMs: 0 } },
    { ntfy: { topic: "t", timeoutMs: 60001 } },
    { ntfy: { topic: "t", timeoutMs: 1.5 } },
    { permissionNotificationDelayMs: 1.5, ntfy: { topic: "t" } },
    { permissionNotificationDelayMs: -1, ntfy: { topic: "t" } },
    { permissionNotificationDelayMs: 300001, ntfy: { topic: "t" } },
    { permissionNotificationDelayMs: "15000", ntfy: { topic: "t" } },
    { permissionNotificationDelayMs: true, ntfy: { topic: "t" } },
    { ntfy: { topic: "t", priority: "nope" } },
    { ntfy: { topic: "t", token: "" } },
    { ntfy: { topic: "t", extra: 1 } },
    { ntfy: { topic: "t" }, extraTop: true },
    { events: { bogus: true }, ntfy: { topic: "t" } },
    { suppressSubagents: { bogus: true }, ntfy: { topic: "t" } },
    { enabled: "yes", ntfy: { topic: "t" } },
    {},
    { ntfy: {} },
    // Invalid server literals: the schema must reject what the runtime rejects.
    { ntfy: { topic: "t", server: "ftp://ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https://user:pass@ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/?a=b" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com/#frag" } },
    { ntfy: { topic: "t", server: "https://ntfy.example.com /x" } },
    { ntfy: { topic: "t", server: "ntfy.example.com" } },
    { ntfy: { topic: "t", server: "" } },
    { ntfy: { topic: "t", server: 42 } },
    // Raw syntax the URL parser alone would accept or mishandle.
    { ntfy: { topic: "t", server: "http:///ntfy.example.com" } },
    { ntfy: { topic: "t", server: "https:///x.test" } },
    { ntfy: { topic: "t", server: "https://x.test:00080" } },
    { ntfy: { topic: "t", server: "https://x.test:080" } },
    { ntfy: { topic: "t", server: "http://foo%20bar.test" } },
    { ntfy: { topic: "t", server: "http://foo%23bar.test" } },
    // Empty delimiters and malformed hosts/ports.
    { ntfy: { topic: "t", server: "https://x.test/?" } },
    { ntfy: { topic: "t", server: "https://x.test/#" } },
    { ntfy: { topic: "t", server: "https://%/" } },
    { ntfy: { topic: "t", server: "https://x.test:abc" } },
    { ntfy: { topic: "t", server: "https://x.test:65536" } },
    // Malformed percent escapes and raw path characters.
    { ntfy: { topic: "t", server: "https://x.test/%" } },
    { ntfy: { topic: "t", server: "https://x.test/%2" } },
    { ntfy: { topic: "t", server: "https://x.test/%GG" } },
    { ntfy: { topic: "t", server: "https://x.test/a{b}" } },
    { ntfy: { topic: "t", server: "https://x.test/a\\b" } },
    { ntfy: { topic: "t", server: "https://x.test/a[b]" } },
    { ntfy: { topic: "t", server: "https://x.test/\u017c" } },
    // Malformed or all-numeric hosts.
    { ntfy: { topic: "t", server: "http://256.256.256.256" } },
    { ntfy: { topic: "t", server: "http://256.0.0.1" } },
    { ntfy: { topic: "t", server: "http://1.2.3.4.5" } },
    { ntfy: { topic: "t", server: "http://4294967296" } },
    { ntfy: { topic: "t", server: "http://99999999999" } },
    { ntfy: { topic: "t", server: "http://01.2.3.4" } },
    // Whitespace-only placeholders.
    { ntfy: { topic: "{env:   }" } },
    { ntfy: { topic: "{file:   }" } },
    { ntfy: { topic: "t", server: "{env:   }" } },
    { ntfy: { topic: "t", server: "{file:   }" } },
  ]

  for (const sample of validSamples) {
    it(`accepts valid sample and schema agrees: ${JSON.stringify(sample)}`, () => {
      expect(validate(structuredClone(sample))).toBe(true)
      const config = normalizeConfig(structuredClone(sample))
      expect(config).toBeDefined()
    })
  }

  for (const sample of invalidSamples) {
    it(`rejects invalid sample and schema agrees: ${JSON.stringify(sample)}`, () => {
      expect(validate(structuredClone(sample))).toBe(false)
      expect(() => normalizeConfig(structuredClone(sample))).toThrow(ConfigError)
    })
  }

  it("schema accepts exact env/file references for server, topic and token", () => {
    expect(validate({ ntfy: { topic: "{env:NTFY_TOPIC}", server: "{env:NTFY_SERVER}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "{file:topic.txt}", server: "{file:server.txt}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "t", token: "{env:NTFY_TOKEN}" } })).toBe(true)
    expect(validate({ ntfy: { topic: "t", token: "plain-token{a}b" } })).toBe(true)
    expect(
      validate({ transport: "webpush", webpush: { ...webpushSection(), privateKey: "{env:VAPID_PRIVATE_KEY}" } }),
    ).toBe(true)
    expect(
      validate({ transport: "webpush", webpush: { ...webpushSection(), storePath: "{file:store.json}" } }),
    ).toBe(true)
  })

  it("schema rejects partial or malformed reference strings", () => {
    const partialSamples = [
      { ntfy: { topic: "pre{env:A}" } },
      { ntfy: { topic: "{env:A}post" } },
      { ntfy: { topic: "{env:A}{env:B}" } },
      { ntfy: { topic: "{env:}" } },
      { ntfy: { topic: "t", server: "https://x.test/{env:P}" } },
      { ntfy: { topic: "t", server: "x{env:A}" } },
      { ntfy: { topic: "t", token: "abc{env:X}" } },
      { ntfy: { topic: "t", token: "{env:X}abc" } },
      { ntfy: { topic: "t", token: "{file:a}b" } },
      { ntfy: { topic: "t", token: "{env:   }" } },
      { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "abc{env:X}" } },
      { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "{env:X}abc" } },
      { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "{file:a}b" } },
      { transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "{env:   }" } },
      { transport: "gotify", gotify: { server: "https://x.test/{env:P}", token: "Aa1ExampleToken" } },
    ]
    for (const sample of partialSamples) {
      expect(validate(structuredClone(sample))).toBe(false)
    }
  })

  it("runtime rejects partial or malformed references with a fixed substitution error", async () => {
    const partialValues: Array<[string, unknown]> = [
      ["topic", "pre{env:A}"],
      ["topic", "{env:A}post"],
      ["topic", "{env:A}{env:B}"],
      ["topic", "{env:}"],
      ["server", "x{env:A}"],
      ["server", "https://x.test/{env:P}"],
      ["token", "abc{env:X}"],
      ["token", "{env:}x"],
      ["token", "{env:   }"],
    ]
    for (const [field, value] of partialValues) {
      const raw = { ntfy: { topic: "t", [field]: value } }
      const error = await rejectionOf(
        parseConfigText(JSON.stringify(raw), { dir: "/tmp", env: { A: "v", X: "w", P: "p" } }),
      )
      expect((error as ConfigError).code).toBe("config.substitution")
      expect(error.message).toContain("entire string value")
    }
  })

  it("runtime accepts exact references after substitution with concrete values", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(
      JSON.stringify({ ntfy: { topic: "{env:NTFY_TOPIC}", server: "{file:server-url.txt}" } }),
      dir,
    )
    await writeFile(join(dir, "opencode", "server-url.txt"), "https://ntfy.example.com/base", "utf8")
    const config = asNtfy(await loadConfigFile(filePath, { env: { NTFY_TOPIC: "env-topic" } }))
    expect(config.ntfy.topic).toBe("env-topic")
    expect(config.ntfy.server).toBe("https://ntfy.example.com/base/")
  })

  it("accepts exact gotify references after substitution with concrete values", async () => {
    const dir = await makeDir()
    const filePath = await writeConfig(
      JSON.stringify({
        transport: "gotify",
        gotify: { server: "{file:gotify-server.txt}", token: "{env:GOTIFY_TOKEN}" },
      }),
      dir,
    )
    await writeFile(join(dir, "opencode", "gotify-server.txt"), "https://gotify.example.com/push", "utf8")
    const config = asGotify(await loadConfigFile(filePath, { env: { GOTIFY_TOKEN: "tok_gotify_token" } }))
    expect(config.gotify.server).toBe("https://gotify.example.com/push/")
    expect(config.gotify.token).toBe("tok_gotify_token")
  })

  it("runtime rejects whitespace-only references with a fixed substitution error", async () => {
    const envError = await rejectionOf(
      parseConfigText(JSON.stringify({ ntfy: { topic: "{env:   }" } }), { dir: "/tmp", env: {} }),
    )
    expect((envError as ConfigError).code).toBe("config.substitution")
    expect(envError.message).not.toContain("{env:   }")
    const fileError = await rejectionOf(
      parseConfigText(JSON.stringify({ ntfy: { topic: "t", token: "{file:  }" } }), { dir: "/tmp" }),
    )
    expect((fileError as ConfigError).code).toBe("config.substitution")
    expect(fileError.message).not.toContain("{file:  }")
  })

  it("agrees on defaults with the JSON Schema default keywords", () => {
    const config = asNtfy(normalizeConfig({ ntfy: { topic: "t" } }))
    expect(config.enabled).toBe(schema.properties.enabled.default)
    expect(config.transport).toBe(schema.properties.transport!.default)
    expect(config.transport).toBe(DEFAULT_TRANSPORT)
    expect(config.ntfy.server).toBe(normalizeServerUrl(schema.properties.ntfy.properties.server.default))
    expect(config.ntfy.priority).toBe(schema.properties.ntfy.properties.priority.default)
    expect(config.ntfy.timeoutMs).toBe(schema.properties.ntfy.properties.timeoutMs.default)
    for (const kind of notificationKinds) {
      expect(config.events[kind]).toBe(schema.properties.events.properties[kind]!.default)
    }
    for (const key of ["session.idle", "session.error"] as const) {
      expect(config.suppressSubagents[key]).toBe(schema.properties.suppressSubagents.properties[key]!.default)
    }
    expect(config.permissionNotificationDelayMs).toBe(schema.properties.permissionNotificationDelayMs.default)
    expect(DEFAULT_NTFY_SERVER).toBe(schema.properties.ntfy.properties.server.default)
    expect(DEFAULT_NTFY_PRIORITY).toBe(schema.properties.ntfy.properties.priority.default)
    expect(DEFAULT_TIMEOUT_MS).toBe(schema.properties.ntfy.properties.timeoutMs.default)
    expect(DEFAULT_PERMISSION_NOTIFICATION_DELAY_MS).toBe(schema.properties.permissionNotificationDelayMs.default)
    const gotifyConfig = asGotify(
      normalizeConfig({ transport: "gotify", gotify: { server: "https://gotify.example.com/", token: "Aa1ExampleToken" } }),
    )
    expect(gotifyConfig.gotify.priority).toBe(schema.properties.gotify.properties.priority.default)
    expect(gotifyConfig.gotify.timeoutMs).toBe(schema.properties.gotify.properties.timeoutMs.default)
    const webpushConfig = asWebpush(
      normalizeConfig({ transport: "webpush", webpush: webpushSection() }),
    )
    expect(webpushConfig.webpush.timeoutMs).toBe(schema.properties.webpush.properties.timeoutMs.default)
    expect(webpushConfig.webpush.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })
})
