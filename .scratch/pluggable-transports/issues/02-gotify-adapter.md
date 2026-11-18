# 02: Gotify Adapter als zweiter Transport

**What to build:** Selecting `transport: gotify` with a `gotify` section (server URL, app token, priority) delivers the four Notification Kinds to a self-hosted Gotify server. The app token travels in a header, never the URL; the plugin's named priority levels map to documented Gotify integer priorities; the publish honors the same bounded, fail-open contract as ntfy. Setup is documented in the README.

**Blocked by:** 01 (Transport-Adapter-Layer mit ntfy als aktivem Transport).

**Status:** done

- [ ] Each Notification Kind produces the documented HTTP request (endpoint, header placement, body, priority) per request-recording tests
- [ ] App token accepted via `{env:}`/`{file:}` reference or literal and never logged; invalid values rejected at startup with a secret-safe error
- [ ] Timeout and fail-open behavior match the shared Transport contract (publish failure logged and swallowed, never blocks the run)
- [ ] Malformed server URLs rejected at startup under the same URL rules as the ntfy server
- [ ] Inactive/active section validation applies (non-empty gotify section with `transport: ntfy` is a startup error)
- [ ] README documents Gotify setup and the priority mapping
