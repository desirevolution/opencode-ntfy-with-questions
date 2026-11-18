# 01: agent.notify forwarding + idle enrichment

**What to build:** An agent's explicit "notify me when ..." request reaches the
phone as a push (new Notification Kind `agent.notify`, tag `bell`, default on),
and idle pushes say what was done: the human session title plus the last
assistant output instead of an opaque session ID.

**Blocked by:** None (can start immediately).

**Status:** done

- [ ] Config: `agentNotifyTools` (array of non-empty strings, bounded count/length, default `["opencode_notify", "openchamber_notify"]`) and `enrichIdleMessages` (boolean, default `true`) validate strictly; unknown keys still rejected
- [ ] The `execute.before` hook forwards a matching notify tool call as an `agent.notify` draft (title `${project} - ${title}`, body or generic fallback) and ignores other tools
- [ ] `events.agent.notify: false` disables the forwarding; notify calls are never suppressed or deduplicated
- [ ] Idle drafts use the session title from the registry cache (fallback: session ID) and the last assistant output from `ctx.session.context`, raced against a 2 s deadline; any failure or timeout falls back to the generic message without a log leak
- [ ] `enrichIdleMessages: false` sends the generic idle message and never calls the context API
- [ ] The session registry caches the title alongside parent/directory and clears it with the session
- [ ] JSON Schema validates the new config surface (positive + negative parity with the runtime validator)
- [ ] README documents the new Notification Kind, the two config options, the hook behavior and the enriched data in "What data is transmitted"
- [ ] CHANGELOG carries the additions in the unpublished 0.3.0; GLOSSARY updated (five Notification Kinds)
- [ ] Full suite, lint, typecheck and build green
