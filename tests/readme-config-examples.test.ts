/**
 * The README's configuration examples are executable documentation.
 *
 * Every ```json block in the README must either be an opencode installer
 * snippet (a `plugin`/`plugins` array) or a plugin configuration that
 * validates against the packaged JSON Schema - the same document the plugin
 * exports. Mutated variants of the same examples pin the negative cases the
 * schema and the runtime must reject, and the ntfy/gotify/webpush examples are
 * parsed end to end so a fresh user can follow the README verbatim.
 */
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import formatsModule from "ajv-formats"
import type { FormatsPlugin } from "ajv-formats"
import { describe, expect, it } from "vitest"

import { generateVAPIDKeys } from "web-push"

import { ConfigError, parseConfigText } from "../src/config.js"
import {
  DEFAULT_TIMEOUT_MS,
  type GotifyPluginConfig,
  type NtfyPluginConfig,
  type PluginConfig,
  type WebPushPluginConfig,
} from "../src/types.js"

/** The public key shown in the README's webpush example (shape only; not a secret). */
const README_WEBPUSH_PUBLIC_KEY = "BPt_voDSmIATroEzyJKd-qO52f2IDeHKjv6elEw3u-B-IHlw7NZEwuYu3f9HwD3g6nh5B5VZW7OKsfubd9r3bKk"

const schemaPath = resolve(process.cwd(), "notification-notifications-with-questions.schema.json")
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>
// format: "uri" on the literal server branch is validated via ajv-formats.
const addFormats =
  (formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin)
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8")
const jsonBlocks = [...readme.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")

interface ReadmeBlock {
  index: number
  json: string
  value?: unknown
  error?: unknown
}

const parsed: ReadmeBlock[] = jsonBlocks.map((json, index) => {
  try {
    return { index, json, value: JSON.parse(json) as unknown }
  } catch (error) {
    return { index, json, error }
  }
})

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Installer snippets are opencode config, never plugin config. */
function isOpencodeSpecifier(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  const keys = Object.keys(record)
  if (keys.length !== 1) return false
  const key = keys[0] as string
  const list = record[key]
  return (key === "plugin" || key === "plugins") && Array.isArray(list) && list.every((entry) => typeof entry === "string")
}

/** The active transport a plugin-config example represents; ntfy by default. */
function transportOf(value: unknown): "ntfy" | "gotify" | "webpush" {
  const transport = asRecord(value)?.["transport"]
  return transport === "gotify" || transport === "webpush" ? transport : "ntfy"
}

function asNtfy(config: PluginConfig): NtfyPluginConfig {
  if (config.transport !== "ntfy") throw new Error("expected an active ntfy Transport")
  return config
}
function asGotify(config: PluginConfig): GotifyPluginConfig {
  if (config.transport !== "gotify") throw new Error("expected an active gotify Transport")
  return config
}
function asWebpush(config: PluginConfig): WebPushPluginConfig {
  if (config.transport !== "webpush") throw new Error("expected an active webpush Transport")
  return config
}

describe("README configuration examples", () => {
  it("has json blocks and every one of them parses as JSON", () => {
    expect(jsonBlocks.length).toBeGreaterThanOrEqual(9)
    for (const block of parsed) {
      expect(block.error, `README json block #${block.index + 1} must parse`).toBeUndefined()
      expect(block.json.trim()).not.toBe("")
    }
  })

  it("every non-installer block is a valid plugin config per the packaged JSON Schema", () => {
    for (const block of parsed) {
      if (block.error !== undefined || isOpencodeSpecifier(block.value)) continue
      const ok = validate(block.value)
      expect(ok, `README block #${block.index + 1} must validate: ${ajv.errorsText(validate.errors)}`).toBe(true)
    }
  })

  it("the installer examples stay opencode specifier objects", () => {
    const specifiers = parsed
      .filter((block) => block.error === undefined && isOpencodeSpecifier(block.value))
      .map((block) => JSON.stringify(block.value))
    expect(specifiers).toEqual(
      expect.arrayContaining([
        JSON.stringify({ plugins: ["opencode-notifications-with-questions@latest"] }),
        JSON.stringify({ plugins: ["opencode-notifications-with-questions@0.3.0"] }),
        JSON.stringify({ plugin: ["opencode-ntfy-with-questions@0.1.2"] }),
      ]),
    )
  })

  it("all three Transports have a README example that validates", () => {
    const configs = parsed.filter((block) => block.error === undefined && !isOpencodeSpecifier(block.value))
    const seen = new Set(configs.map((block) => transportOf(block.value)))
    expect([...seen].sort()).toEqual(["gotify", "ntfy", "webpush"])
  })

  it("every ntfy example parses end to end, env and file references included", async () => {
    const home = await mkdtemp(join(tmpdir(), "ntfy-readme-"))
    try {
      await mkdir(join(home, "secrets"), { recursive: true })
      await writeFile(join(home, "secrets", "ntfy-token.txt"), "tok-from-file\n", "utf8")
      const env = { NTFY_TOKEN: "tok-from-env" }
      const ntfyBlocks = parsed.filter(
        (block) => block.error === undefined && !isOpencodeSpecifier(block.value) && transportOf(block.value) === "ntfy",
      )
      expect(ntfyBlocks.length).toBeGreaterThanOrEqual(4)
      for (const block of ntfyBlocks) {
        const config = asNtfy(await parseConfigText(block.json, { dir: home, env, home }))
        expect(config.ntfy.topic).not.toBe("")
      }
      const fileExample = ntfyBlocks.find((block) => block.json.includes("{file:"))
      expect(fileExample).toBeDefined()
      const fromFile = asNtfy(await parseConfigText(fileExample?.json ?? "", { dir: home, env, home }))
      expect(fromFile.ntfy.token).toBe("tok-from-file")
      const envExample = ntfyBlocks.find((block) => block.json.includes("{env:"))
      expect(envExample).toBeDefined()
      const fromEnv = asNtfy(await parseConfigText(envExample?.json ?? "", { dir: home, env, home }))
      expect(fromEnv.ntfy.token).toBe("tok-from-env")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("the gotify example parses end to end with the token from the environment", async () => {
    const block = parsed.find(
      (candidate) =>
        candidate.error === undefined && !isOpencodeSpecifier(candidate.value) && transportOf(candidate.value) === "gotify",
    )
    expect(block).toBeDefined()
    const config = asGotify(await parseConfigText(block?.json ?? "", { dir: "/tmp", env: { GOTIFY_TOKEN: "tok-gotify" } }))
    expect(config.gotify.server).toBe("https://gotify.example.com/")
    expect(config.gotify.token).toBe("tok-gotify")
    expect(config.gotify.priority).toBe("high")
    expect(config.gotify.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it("the webpush example keeps its documented shape and parses end to end with generated keys", async () => {
    const block = parsed.find(
      (candidate) =>
        candidate.error === undefined && !isOpencodeSpecifier(candidate.value) && transportOf(candidate.value) === "webpush",
    )
    expect(block).toBeDefined()
    const example = asRecord(block?.value)?.["webpush"] as Record<string, unknown>
    // The example must stay exactly the documented shape: its key values are
    // placeholders, everything else is copy-paste.
    expect(example).toEqual({
      subject: "mailto:you@example.com",
      publicKey: README_WEBPUSH_PUBLIC_KEY,
      privateKey: "{env:VAPID_PRIVATE_KEY}",
      storePath: "/srv/opencode/subscriptions.json",
    })

    // The documented loop - generate, paste, reference the private key - must
    // load end to end. Uses freshly generated keys instead of shipping a
    // private key anywhere.
    const { publicKey, privateKey } = generateVAPIDKeys()
    const config = asWebpush(
      await parseConfigText(
        JSON.stringify({
          transport: "webpush",
          webpush: {
            subject: "mailto:you@example.com",
            publicKey,
            privateKey: "{env:VAPID_PRIVATE_KEY}",
            storePath: "/srv/opencode/subscriptions.json",
          },
        }),
        { dir: "/tmp", env: { VAPID_PRIVATE_KEY: privateKey } },
      ),
    )
    expect(config.webpush.publicKey).toBe(publicKey)
    expect(config.webpush.storePath).toBe("/srv/opencode/subscriptions.json")
    expect(config.webpush.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  describe("mutated examples are rejected", () => {
    function webpushExample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        transport: "webpush",
        webpush: {
          subject: "mailto:you@example.com",
          publicKey: README_WEBPUSH_PUBLIC_KEY,
          privateKey: "{env:VAPID_PRIVATE_KEY}",
          storePath: "/srv/opencode/subscriptions.json",
          ...overrides,
        },
      }
    }

    const mutatedSamples: Array<{ name: string; value: Record<string, unknown> }> = [
      { name: "ntfy example with an unknown key", value: { ntfy: { topic: "my-opencode-alerts", tokens: "tk_nope" } } },
      { name: "ntfy example with an invalid topic", value: { ntfy: { topic: "my opencode alerts" } } },
      {
        name: "complete example with an out-of-range timeout",
        value: {
          enabled: true,
          events: { "session.idle": true, "session.error": true, "permission.asked": true, "question.asked": true },
          ntfy: { server: "https://ntfy.sh", topic: "my-opencode-alerts", timeoutMs: 60001 },
        },
      },
      {
        name: "self-hosted example with a malformed reference",
        value: { ntfy: { server: "https://ntfy.example.com", topic: "opencode", token: "{env:NTFY_TOKEN" } },
      },
      {
        name: "gotify example without a token",
        value: { transport: "gotify", gotify: { server: "https://gotify.example.com", priority: "high" } },
      },
      {
        name: "gotify example with an unknown priority",
        value: {
          transport: "gotify",
          gotify: { server: "https://gotify.example.com", token: "{env:GOTIFY_TOKEN}", priority: "urgent" },
        },
      },
      {
        name: "gotify example with server credentials",
        value: {
          transport: "gotify",
          gotify: { server: "https://user:pass@gotify.example.com", token: "{env:GOTIFY_TOKEN}" },
        },
      },
      {
        name: "gotify example with a zero timeout",
        value: {
          transport: "gotify",
          gotify: { server: "https://gotify.example.com", token: "{env:GOTIFY_TOKEN}", timeoutMs: 0 },
        },
      },
      { name: "webpush example with a malformed public key", value: webpushExample({ publicKey: "not-a-key" }) },
      { name: "webpush example with a non-contact subject", value: webpushExample({ subject: "you@example.com" }) },
      { name: "webpush example with an empty store path", value: webpushExample({ storePath: "" }) },
      { name: "webpush example with a partial reference", value: webpushExample({ privateKey: "VAPID_{env:X}" }) },
      { name: "webpush example with an unknown key", value: webpushExample({ topic: "opencode" }) },
      {
        name: "webpush example next to a non-empty ntfy section",
        value: { transport: "webpush", webpush: webpushExample().webpush as Record<string, unknown>, ntfy: { topic: "opencode" } },
      },
      {
        name: "gotify section configured while transport is ntfy",
        value: {
          ntfy: { topic: "my-opencode-alerts" },
          gotify: { server: "https://gotify.example.com", token: "{env:GOTIFY_TOKEN}" },
        },
      },
    ]

    for (const sample of mutatedSamples) {
      it(`the schema rejects: ${sample.name}`, () => {
        expect(validate(structuredClone(sample.value)), sample.name).toBe(false)
      })
    }

    for (const sample of mutatedSamples) {
      it(`the runtime rejects: ${sample.name}`, async () => {
        await expect(parseConfigText(JSON.stringify(sample.value), { dir: "/tmp", env: {} })).rejects.toThrow(ConfigError)
      })
    }
  })
})
