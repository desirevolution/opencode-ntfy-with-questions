import { describe, expect, it, vi } from "vitest"

import { normalizeConfig } from "../src/config.js"
import { createPluginHandlers, type Logger, type SessionLookupResult } from "../src/notification-handlers.js"
import { SessionRegistry } from "../src/session-registry.js"
import { createNtfyTransport, type TransportAdapter } from "../src/transport.js"
import type { NtfySettings, NotificationDraft, PluginConfig } from "../src/types.js"

function config(
  overrides: {
    enabled?: boolean
    events?: Record<string, boolean>
    suppressSubagents?: { "session.idle"?: boolean; "session.error"?: boolean }
    agentNotifyTools?: string[]
    enrichIdleMessages?: boolean
    ntfy?: Partial<NtfySettings>
  } = {},
): PluginConfig {
  return normalizeConfig({
    permissionNotificationDelayMs: 0,
    enabled: overrides.enabled ?? true,
    events: overrides.events,
    suppressSubagents: overrides.suppressSubagents,
    agentNotifyTools: overrides.agentNotifyTools,
    enrichIdleMessages: overrides.enrichIdleMessages,
    ntfy: { topic: "demo-topic", ...overrides.ntfy },
  })
}

function harness(
  overrides: {
    config?: PluginConfig
    registry?: SessionRegistry
    publish?: (draft: NotificationDraft) => Promise<void> | void
    get?: (sessionID: string) => Promise<SessionLookupResult>
    getSessionContext?: (sessionID: string) => Promise<unknown>
    sessionContextTimeoutMs?: number
    log?: Logger
    now?: () => number
  } = {},
) {
  const sent: NotificationDraft[] = []
  const publish =
    overrides.publish ??
    (async (draft: NotificationDraft) => {
      sent.push(draft)
    })
  // A sync-throwing publish must still reach the handler untouched, so the
  // publish is cast instead of wrapped in an async adapter.
  const transport = { publish, describeError: () => "publish failed" } as unknown as TransportAdapter
  const logMessages: string[] = []
  const logger: Logger = overrides.log ?? ((message: string) => logMessages.push(message))
  const getMock = vi.fn(async (sessionID: string) => (overrides.get ? overrides.get(sessionID) : {}))
  const registry = overrides.registry ?? new SessionRegistry()
  const handlers = createPluginHandlers({
    config: overrides.config ?? config(),
    projectName: "demo-project",
    directory: "/proj",
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.getSessionContext ? { getSessionContext: overrides.getSessionContext } : {}),
    ...(overrides.sessionContextTimeoutMs !== undefined ? { sessionContextTimeoutMs: overrides.sessionContextTimeoutMs } : {}),
    getSession: getMock,
    transport,
    registry,
    log: logger,
  })
  return { handlers, sent, logMessages, getMock, registry }
}

const executionSucceeded = (sessionID: string) => ({
  event: { id: "evt_done", type: "session.execution.succeeded", created: 1, data: { sessionID } },
})

const idle = (sessionID: string) => ({
  event: { id: "evt_idle", type: "session.status", created: 1, data: { sessionID, status: { type: "idle" } } },
})
const sessionError = (sessionID: string | undefined, error?: unknown) => ({
  event: {
    id: "evt_err",
    type: "session.execution.failed",
    created: 1,
    data: { ...(sessionID ? { sessionID } : {}), error: error ?? { type: "UnknownError", message: "provider boom" } },
  },
})
const created = (sessionID: string, parentID?: string) => ({
  event: { id: "evt_created", type: "session.created", created: 1, data: { sessionID, ...(parentID ? { parentID } : {}) } },
})
const deleted = (sessionID: string) => ({
  event: { id: "evt_deleted", type: "session.deleted", created: 1, data: { sessionID } },
})
const permissionAsked = (sessionID: string | undefined) => ({
  event: {
    id: "evt_perm",
    type: "permission.asked",
    created: 1,
    data: { id: "per_1", ...(sessionID ? { sessionID } : {}), action: "edit", resources: ["**/*.ts"] },
  },
})

describe("idle and error routing", () => {
  it("notifies on session.status idle for a known root session", async () => {
    const h = harness()
    h.registry.record("sess_root", null)
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("demo-project")
    expect(h.sent[0]?.message).toContain("sess_root")
    expect(h.sent[0]?.tags).toEqual(["hourglass_done"])
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("suppresses idle for a known child session", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(idle("sess_child"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("suppresses error for a known child session", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(sessionError("sess_child"))
    expect(h.sent).toHaveLength(0)
  })

  it("notifies on a terminal failure even without a sessionID", async () => {
    const h = harness()
    await h.handlers.event(sessionError(undefined))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["warning"])
    expect(h.sent[0]?.message).toContain("provider boom")
  })

  it("respects the session.error and session.idle event toggles", async () => {
    const h = harness({ config: config({ events: { "session.error": false } }) })
    await h.handlers.event(sessionError(undefined))
    expect(h.sent).toHaveLength(0)
    h.registry.record("sess_root", null)
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
  })

  it("notifies child idle/error when suppressSubagents is disabled", async () => {
    const h = harness({ config: config({ suppressSubagents: { "session.idle": false, "session.error": false } }) })
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(idle("sess_child"))
    await h.handlers.event(sessionError("sess_child"))
    expect(h.sent).toHaveLength(2)
  })
})

describe("subagent classification", () => {
  it("classifies an unknown session via the direct lookup and suppresses when it has a parent", async () => {
    const h = harness({ get: async () => ({ parentID: "sess_parent" }) })
    await h.handlers.event(idle("sess_mystery"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.registry.parentOf("sess_mystery")).toBe("sess_parent")
    // Second event hits the cache and skips the lookup.
    await h.handlers.event(idle("sess_mystery"))
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("fails open when the lookup reports a root session", async () => {
    const h = harness()
    await h.handlers.event(idle("sess_root_unknown"))
    expect(h.sent).toHaveLength(1)
    expect(h.registry.parentOf("sess_root_unknown")).toBeNull()
    expect(h.logMessages).toHaveLength(0)
  })

  it("fails open with a warning when the lookup rejects", async () => {
    const h = harness({
      get: async () => {
        throw new Error("client down")
      },
    })
    await h.handlers.event(idle("sess_err"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_err"))).toBe(true)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
  })

  it("fails open with a warning when the lookup throws synchronously", async () => {
    const h = harness()
    h.getMock.mockImplementationOnce(() => {
      throw new Error("sync boom")
    })
    await h.handlers.event(idle("sess_sync"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("sess_sync"))).toBe(true)
  })

  it("fails open with a warning when the lookup returns an invalid result", async () => {
    const h = harness({ get: async () => null as unknown as SessionLookupResult })
    await h.handlers.event(idle("sess_no_data"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages.some((message) => message.includes("lookup failed"))).toBe(true)
    // The failed lookup must not poison the cache with a guessed classification.
    expect(h.registry.parentOf("sess_no_data")).toBeUndefined()
  })

  it("lets a lifecycle cache update supersede an in-flight lookup result", async () => {
    let resolveLookup!: (result: SessionLookupResult) => void
    const pendingLookup = new Promise<SessionLookupResult>((resolve) => {
      resolveLookup = resolve
    })
    const h = harness({ get: () => pendingLookup })
    const idlePromise = h.handlers.event(idle("sess_race"))
    // While the lookup is still pending, a lifecycle event refreshes the cache.
    await h.handlers.event(created("sess_race", "sess_parent"))
    resolveLookup({})
    await idlePromise
    expect(h.sent).toHaveLength(0)
    expect(h.registry.parentOf("sess_race")).toBe("sess_parent")
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("suppresses a child error found only via the fallback lookup", async () => {
    const h = harness({ get: async () => ({ parentID: "sess_parent" }) })
    await h.handlers.event(sessionError("sess_hidden_child"))
    expect(h.sent).toHaveLength(0)
  })
})

describe("location-less execution events (opencode >= 2.2)", () => {
  it("notifies a location-less execution.succeeded whose session directory matches", async () => {
    const h = harness({ get: async () => ({ location: { directory: "/proj" } }) })
    await h.handlers.event(executionSucceeded("sess_done"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["hourglass_done"])
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.logMessages).toHaveLength(0)
  })

  it("drops a location-less execution event owned by another directory", async () => {
    const h = harness({ get: async () => ({ location: { directory: "/elsewhere" } }) })
    await h.handlers.event(executionSucceeded("sess_foreign"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("drops a location-less execution error owned by another directory", async () => {
    const h = harness({ get: async () => ({ directory: "/elsewhere" }) })
    await h.handlers.event(sessionError("sess_fail_foreign"))
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("fails open silently when the lookup carries no directory (older opencode)", async () => {
    const h = harness()
    await h.handlers.event(executionSucceeded("sess_legacy"))
    expect(h.sent).toHaveLength(1)
    expect(h.logMessages).toHaveLength(0)
  })

  it("one lookup answers ownership and subagent suppression", async () => {
    const h = harness({ get: async () => ({ parentID: "sess_parent", location: { directory: "/proj" } }) })
    await h.handlers.event(executionSucceeded("sess_child_done"))
    // Owned by this instance, but a known subagent: suppressed, one lookup.
    expect(h.sent).toHaveLength(0)
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("drops the secondary session.status idle within the dedup window after an execution idle", async () => {
    let clock = 0
    const h = harness({ get: async () => ({ location: { directory: "/proj" } }), now: () => clock })
    await h.handlers.event(executionSucceeded("sess_both"))
    expect(h.sent).toHaveLength(1)
    clock = 100
    await h.handlers.event(idle("sess_both"))
    expect(h.sent).toHaveLength(1)
    // The dedup check short-circuits before any lookup.
    expect(h.getMock).toHaveBeenCalledTimes(1)
  })

  it("notifies again once the dedup window has passed", async () => {
    let clock = 0
    const h = harness({ get: async () => ({ location: { directory: "/proj" } }), now: () => clock })
    await h.handlers.event(executionSucceeded("sess_again"))
    expect(h.sent).toHaveLength(1)
    clock = 3000
    await h.handlers.event(idle("sess_again"))
    expect(h.sent).toHaveLength(2)
  })

  it("never deduplicates the primary source", async () => {
    const h = harness({ get: async () => ({ location: { directory: "/proj" } }) })
    await h.handlers.event(executionSucceeded("sess_primary"))
    await h.handlers.event(executionSucceeded("sess_primary"))
    expect(h.sent).toHaveLength(2)
  })
})

describe("agent.notify forwarding and idle enrichment", () => {
  const notifyArgs = { title: "Build finished", body: "npm run build succeeded" }

  it("forwards a configured notify tool call with title, body and the bell tag", async () => {
    const h = harness()
    await h.handlers.notify("opencode_notify", notifyArgs)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toEqual({
      kind: "agent.notify",
      title: "demo-project - Build finished",
      message: "npm run build succeeded",
      tags: ["bell"],
    })
  })

  it("accepts the nested {action, parameters} shape and falls back for missing fields", async () => {
    const h = harness()
    await h.handlers.notify("openchamber_notify", { action: "notify.send", parameters: { title: "Done" } })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.title).toContain("Done")
    expect(h.sent[0]?.message).toBe("The agent asked to notify you.")
  })

  it("ignores unlisted tools, respects the toggle, and never throws on malformed args", async () => {
    const h = harness()
    await h.handlers.notify("bash", notifyArgs)
    expect(h.sent).toHaveLength(0)
    const off = harness({ config: config({ events: { "agent.notify": false } }) })
    await off.handlers.notify("opencode_notify", notifyArgs)
    expect(off.sent).toHaveLength(0)
    for (const args of [undefined, null, "text", {}]) {
      const one = harness()
      await one.handlers.notify("opencode_notify", args)
      expect(one.sent).toHaveLength(1)
    }
  })

  it("forwards custom configured tool names", async () => {
    const h = harness({ config: config({ agentNotifyTools: ["my_notify"] }) })
    await h.handlers.notify("my_notify", notifyArgs)
    expect(h.sent).toHaveLength(1)
    await h.handlers.notify("opencode_notify", notifyArgs)
    expect(h.sent).toHaveLength(1)
  })

  it("enriches the idle notification with the session title and last output", async () => {
    let contextCalls = 0
    const h = harness({
      get: async () => ({ location: { directory: "/proj" }, title: "Fix login bug" }),
      getSessionContext: async () => {
        contextCalls += 1
        return [{ type: "assistant", content: [{ type: "text", text: "Fixed the redirect loop." }] }]
      },
    })
    await h.handlers.event(executionSucceeded("sess_title"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain("Fix login bug")
    expect(h.sent[0]?.message).toContain("Fixed the redirect loop.")
    expect(contextCalls).toBe(1)
  })

  it("falls back to the generic idle message when the context call fails", async () => {
    const h = harness({
      get: async () => ({ location: { directory: "/proj" } }),
      getSessionContext: async () => {
        throw new Error("context endpoint down")
      },
    })
    await h.handlers.event(executionSucceeded("sess_failmsg"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain('"sess_failmsg"')
    expect(h.sent[0]?.message).not.toContain("Fixed")
  })

  it("races the context call against the enrichment deadline", async () => {
    const h = harness({
      get: async () => ({ location: { directory: "/proj" } }),
      getSessionContext: () => new Promise(() => {}),
      sessionContextTimeoutMs: 20,
    })
    const started = Date.now()
    await h.handlers.event(executionSucceeded("sess_hang_ctx"))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toContain('"sess_hang_ctx"')
  })

  it("sends generic idle messages when enrichment is off", async () => {
    let contextCalls = 0
    const h = harness({
      config: config({ enrichIdleMessages: false }),
      get: async () => ({ location: { directory: "/proj" }, title: "Fix login bug" }),
      getSessionContext: async () => {
        contextCalls += 1
        return []
      },
    })
    await h.handlers.event(executionSucceeded("sess_plain"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.message).toBe('Session "sess_plain" has finished its run and is idle.\nIt is waiting for your next instruction.')
    expect(contextCalls).toBe(0)
  })

  it("uses the session title without a context call when the title is cached", async () => {
    const h = harness({ get: async () => ({ location: { directory: "/proj" }, title: "Fix login bug" }) })
    await h.handlers.event(executionSucceeded("sess_named"))
    expect(h.sent[0]?.message).toContain("Fix login bug")
  })
})

describe("session lifecycle cache", () => {
  it("learns about children and root sessions from session.created", async () => {
    const h = harness()
    await h.handlers.event(created("sess_child", "sess_parent"))
    await h.handlers.event(created("sess_root"))
    await h.handlers.event(idle("sess_child"))
    await h.handlers.event(idle("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.getMock).not.toHaveBeenCalled()
  })

  it("cleans the cache on session.deleted and falls back to the lookup again", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(deleted("sess_child"))
    expect(h.registry.parentOf("sess_child")).toBeUndefined()
    await h.handlers.event(idle("sess_child"))
    expect(h.getMock).toHaveBeenCalledTimes(1)
    expect(h.sent).toHaveLength(1)
  })
})

describe("permission routing", () => {
  it("notifies on permission.asked with action and resources", async () => {
    const h = harness()
    await h.handlers.event(permissionAsked("sess_root"))
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.tags).toEqual(["lock"])
    expect(h.sent[0]?.message).toContain('"edit"')
    expect(h.sent[0]?.message).toContain("**/*.ts")
    expect(h.sent[0]?.message).toContain("sess_root")
  })

  it("always notifies for permissions from child sessions", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.event(permissionAsked("sess_child"))
    expect(h.sent).toHaveLength(1)
  })

  it("respects the permission.asked toggle and tolerates a missing sessionID", async () => {
    const off = harness({ config: config({ events: { "permission.asked": false } }) })
    await off.handlers.event(permissionAsked("sess_root"))
    expect(off.sent).toHaveLength(0)
    const on = harness()
    await on.handlers.event(permissionAsked(undefined))
    expect(on.sent).toHaveLength(1)
  })
})

describe("question routing", () => {
  const questionArgs = {
    questions: [
      {
        question: "Which option do you prefer?",
        header: "Pick one",
        options: [
          { label: "Option A", description: "First choice" },
          { label: "Option B", description: "Second choice" },
        ],
      },
      { question: "Pick any number?", header: "Multi", multiple: true, options: [{ label: "One", description: "" }] },
    ],
  }

  it("notifies from the question hook with the full formatted content", async () => {
    const h = harness()
    await h.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(1)
    const message = h.sent[0]?.message ?? ""
    expect(h.sent[0]?.tags).toEqual(["question"])
    expect(message).toContain("Which option do you prefer?")
    expect(message).toContain("Option A")
    expect(message).toContain("Multiple answers: allowed")
    expect(message).toContain("Multiple answers: not allowed")
  })

  it("does not notify for other tools or when the question toggle is off", async () => {
    const h = harness()
    await h.handlers.question("bash", questionArgs)
    const off = harness({ config: config({ events: { "question.asked": false } }) })
    await off.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(0)
    expect(off.sent).toHaveLength(0)
  })

  it("notifies when a child session asks a question", async () => {
    const h = harness()
    h.registry.record("sess_child", "sess_parent")
    await h.handlers.question("question", questionArgs)
    expect(h.sent).toHaveLength(1)
  })

  it("sends one generic notification for malformed args instead of throwing", async () => {
    for (const args of [null, undefined, "text", {}, { questions: [] }]) {
      const h = harness()
      await expect(h.handlers.question("question", args)).resolves.toBeUndefined()
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]?.message).toContain("unreadable question payload")
    }
  })
})

describe("failure containment", () => {
  it("contains an async and a synchronous publish failure", async () => {
    const asyncFailure = harness({
      publish: async () => {
        throw new Error("ntfy is down")
      },
    })
    asyncFailure.registry.record("sess_root", null)
    await expect(asyncFailure.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    expect(asyncFailure.logMessages.length).toBeGreaterThan(0)

    const syncFailure = harness({
      publish: () => {
        throw new Error("sync publish failure")
      },
    })
    syncFailure.registry.record("sess_root", null)
    await expect(syncFailure.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
  })

  it("never blocks the question tool when publishing fails", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("down")
      },
    })
    await expect(h.handlers.question("question", { questions: [{ question: "Go?", header: "H", options: [] }] })).resolves.toBeUndefined()
  })

  it("survives a throwing logger during a publish failure", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("down")
      },
      log: () => {
        throw new Error("logger boom")
      },
    })
    h.registry.record("sess_root", null)
    await expect(h.handlers.event(idle("sess_root"))).resolves.toBeUndefined()
    await expect(h.handlers.question("question", { questions: [] })).resolves.toBeUndefined()
  })
})

describe("log redaction", () => {
  it("never logs the token, topic or notification payload", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network exploded")
    })
    const ntfySettings: NtfySettings = {
      server: "https://ntfy.example.com/",
      topic: "demo-topic",
      token: "super-secret-token-xyz",
      priority: "default",
      timeoutMs: 5000,
    }
    const logMessages: string[] = []
    const handlers = createPluginHandlers({
      config: config({ ntfy: ntfySettings }),
      projectName: "demo-project",
        directory: "/proj",
      getSession: async () => ({}),
      transport: createNtfyTransport(ntfySettings, { fetch: fetchMock as unknown as typeof fetch }),
      registry: new SessionRegistry(),
      log: (message) => logMessages.push(message),
    })
    await handlers.event(idle("sess_root"))
    expect(fetchMock).toHaveBeenCalled()
    const joined = logMessages.join("\n")
    expect(joined).not.toContain("super-secret-token-xyz")
    expect(joined).not.toContain("demo-topic")
    expect(joined).not.toContain("sess_root")
  })
})
