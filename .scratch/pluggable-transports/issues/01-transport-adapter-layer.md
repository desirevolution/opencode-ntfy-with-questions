# 01: Transport-Adapter-Layer mit ntfy als aktivem Transport (Prefactor)

**What to build:** The notification handlers depend on a Transport Adapter interface instead of the ntfy client directly. A new `transport` config key selects the active Transport, defaulting to `ntfy`; existing configs (no key) behave byte-identically to today. The ntfy Adapter wraps today's publish behavior exactly — same request shape, timeout, fail-open semantics and concurrency bounds. The strict startup rules are established here for all Transports: unknown keys rejected anywhere, only `ntfy` accepted as transport value for now, and a non-empty inactive Transport section rejected as a misconfiguration signal.

**Blocked by:** None (can start immediately).

**Status:** done

- [ ] Existing configs without a `transport` key produce identical publishes and identical startup behavior
- [ ] `transport: ntfy` behaves identically; any other value is rejected at startup with an actionable, secret-safe error
- [ ] A non-empty inactive Transport section is rejected at startup; empty/absent sections are fine
- [ ] Unknown config keys anywhere are still rejected; secrets are never logged (existing discipline)
- [ ] Handler tests run against a fake Transport Adapter (the new seam); all existing test suites stay green unchanged
- [ ] The exported schema document validates the new config surface with positive and negative cases
- [ ] No change to event adapter, subagent suppression or permission grace period behavior
