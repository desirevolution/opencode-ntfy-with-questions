# Spec: Pluggable notification transports (ntfy retained, Gotify and Web Push added)

Status: done
Decision record: ADR-0001 (docs/adr/0001-pluggable-notification-transports.md)

## Problem Statement

As a plugin user I receive opencode session notifications on my devices via
ntfy. Both the ntfy server configuration and the ntfy app feel confusing and
diffuse to me, and the topic-as-secret model is thin. I want a transport whose
setup is obvious, and one that needs no app or server at all — but I will not
accept a third-party provider that can read my notification content, my
terminal workflow (answering permissions and questions there) must not change,
and my existing setup must survive the upgrade untouched.

## Solution

The plugin grows a thin transport adapter layer. A single config key selects
the active Transport — `ntfy` (today's behavior, the default), `gotify` (the
simple self-hosted alternative: one server binary, one config file, an
official uncluttered app), or `webpush` (Notifications straight to desktop and
Android-Chrome browsers, payload encrypted end to end, no app and no server
needed). For Web Push, devices register and deregister themselves on a small
Bootstrap Service that the user hosts behind their reverse proxy; it writes a
Subscription Store that the plugin reads at publish time, so devices come and
go without restarting opencode. The release is non-breaking (0.3.0): existing
ntfy configs keep working verbatim.

## User Stories

1. As a plugin user, I want to pick the Transport with one config key, so that I can switch channels without learning a new plugin.
2. As a plugin user upgrading from the current release, I want my existing ntfy config to keep working unchanged, so that the upgrade is not breaking.
3. As a plugin user, I want `ntfy` to remain the default Transport, so that an upgrade without config changes behaves exactly as before.
4. As a plugin user, I want unknown config keys rejected at startup as today, so that typos never silently disable Notifications.
5. As a plugin user, I want a configured-but-inactive Transport section rejected at startup, so that I never believe a channel is live when it is not.
6. As a plugin user, I want startup errors that name the offending config key but never secret values, so that debugging is safe (existing discipline preserved).
7. As a plugin user, I want Notification Kind titles and priorities preserved for every Transport, so that my Notification vocabulary stays stable across channels.
8. As a privacy-conscious user, I want no Transport option that shows my message content to a third-party provider in plaintext, so that my posture (third-party cloud for metadata, not content) holds by construction.
9. As a one-way user, I want the plugin to remain publish-only, so that answering permissions and questions stays a terminal workflow.

### Gotify

10. As a Gotify user, I want to point the plugin at my self-hosted server and app token, so that Notifications land in my Gotify app.
11. As a Gotify user, I want the app token accepted via `{env:}`/`{file:}` reference or literal and never logged, so that the secret discipline holds.
12. As a Gotify user, I want the four Notification Kinds mapped to sensible Gotify priorities, so that my phone distinguishes idle from permission prompts.
13. As a Gotify user, I want the same bounded publish timeout and fail-open behavior as today, so that a slow Gotify server can never block opencode.
14. As a Gotify user, I want publish failures logged and swallowed, so that transport outages never break the agent run.

### Web Push

15. As a Web Push user, I want Notifications delivered to my browser without installing an app, so that I receive pushes with zero extra tooling.
16. As a Web Push user, I want the payload encrypted end to end, so that the browser vendor's push service sees only ciphertext.
17. As an Android or desktop user, I want delivery that works with the browser not open, so that I don't have to keep anything running (Android Chrome delivers via the system push channel; no PWA install needed).
18. As a Web Push user, I want to register a device by opening the Bootstrap Service page, so that registration is one click.
19. As a Web Push user, I want to deregister a device from the same page, so that lost or retired devices stop receiving my session data.
20. As a Web Push user, I want registrations to take effect without restarting opencode, so that I never restart my IDE to add a phone.
21. As a Web Push user with several devices, I want a Notification fanned out to every Subscription, so that all my browsers receive it.
22. As a Web Push user whose device is unreachable, I want the remaining Subscriptions still tried and the failure logged, so that one dead device doesn't kill delivery.
23. As a Web Push user, I want expired Subscriptions (410 Gone) removed from the Subscription Store automatically, so that dead endpoints don't accumulate.
24. As a Web Push user, I want the VAPID subject and keys in the config with the private key only via `{env:}`/`{file:}` reference or literal, so that the private key never lands in a repository or log.
25. As a Web Push user, I want every received push shown as a visible Notification, so that the browser does not revoke my Subscription for silent pushes.
26. As a Web Push user, I want a per-publish deadline bounding the whole fan-out, so that an unreachable push service cannot stall the plugin.

### Bootstrap Service and Subscription Store

27. As a self-hoster, I want the Bootstrap Service shipped with the package, so that I don't clone or assemble anything extra.
28. As a self-hoster, I want to host the Bootstrap Service behind my reverse proxy with TLS, so that subscribe works (secure context) and the page stays private.
29. As a self-hoster, I want the Bootstrap Service and the plugin to share one Subscription Store file, so that registrations are visible to the plugin on the same machine.
30. As a security-conscious user, I want the Bootstrap Service to accept only well-formed Subscription payloads, so that a malformed request cannot corrupt the store.
31. As a user, I want the Bootstrap Service to hold no accounts and no data beyond Subscriptions, so that hosting it stays low-risk.
32. As a multi-host user, I want a documented manual path to copy a Subscription to a second opencode instance, so that other machines can deliver too.
33. As a maintainer, I want store writes to be atomic, so that a crash mid-write never leaves a half-written store behind.

### Documentation and maintenance

34. As a plugin user, I want a README transport matrix, so that I pick the right channel in minutes.
35. As a maintainer, I want a recorded verification that the Web Push library works under the plugin runtime before anything depends on it, so that we don't build on sand.
36. As a future contributor, I want ADR-0001 and the Adapter interface documented, so that adding Transport number four is obvious.
37. As a plugin user, I want the repo/npm name's historic "ntfy" explained, so that the name doesn't mislead about scope.

## Implementation Decisions

- Architecture: a thin Transport Adapter layer behind one interface; the
  notification handlers depend on the interface, not on any channel. Exactly
  one Transport is active per instance, selected by a new config enum with
  default `ntfy` (ADR-0001).
- The ntfy Adapter wraps the existing publish client with unchanged behavior:
  same request shape, same timeout and fail-open semantics, same concurrency
  bounds. No behavioral change is in scope for it.
- The Gotify Adapter posts to the configured server's message endpoint with the
  app token in a header (never the URL), title/message/priority in the body,
  and a documented mapping from the plugin's named priority levels to Gotify
  integer priorities. It honors the same bounded, fail-open publish contract.
- Config: the transport enum plus per-Transport sections (ntfy as today;
  gotify and webpush new). The active section is strictly validated; an
  inactive section that is non-empty is a startup error. Unknown keys anywhere
  remain rejected. Secrets (app token, VAPID private key) only via
  `{env:}`/`{file:}` reference or validated literal; never logged.
- The Web Push Adapter uses the web-push library — the sole new runtime
  dependency, accepted in ADR-0001. It fans out over every Subscription in the
  Subscription Store, isolates per-Subscription failures, cleans up 410-Gone
  endpoints via an atomic store write, and always shows a visible Notification.
- Subscription Store: a JSON file written by the Bootstrap Service and read
  fresh by the Adapter at publish time (this is what makes register/deregister
  work without restarting opencode). Atomic writes (temp file + rename).
  Per-publish reads tolerate malformed entries by skipping and logging — the
  store is the plugin's first non-startup-validated file, by design.
- VAPID: subject and keypair live in the webpush config section; the public
  key is also configured for the Bootstrap Service to hand to browsers.
- Bootstrap Service: shipped with the package (a small handler plus one page);
  register = browser-side subscribe followed by a POST that appends to the
  store; deregister = unsubscribe plus removal. Assumes plugin and service see
  the same store file (same host or shared mount); multi-host is the
  documented manual copy path. No accounts, no data beyond Subscriptions.
- Release: 0.3.0, non-breaking. Repo and npm name unchanged (the "ntfy" is
  historic and documented as such); the exported schema document keeps its
  name and gains the new sections.
- No changes to the event adapter, subagent suppression, permission grace
  period, or any Notification Kind semantics.

## Testing Decisions

- A good test asserts external behavior only: the outgoing HTTP request for a
  given event and config, startup validation outcomes, and store mutations on
  register, deregister and 410 cleanup. Implementation internals stay untested.
- Handler wiring is tested with a fake Transport Adapter (prior art: the
  existing fake-publisher handler tests and fake v2 context suites).
- Each Adapter's HTTP boundary is tested by request recording — existing
  ntfy request-recording tests are kept and extended; Gotify gets the same
  pattern. The Web Push Adapter is tested against a local ephemeral endpoint
  server with the real library and real crypto, at the highest honest seam.
- The Subscription Store is tested over real temp files, following the
  existing config tests' temp-directory pattern — no filesystem mocks.
- The Bootstrap handler is tested over plain HTTP. The browser-side page JS is
  intentionally minimal and is covered by typecheck plus a manual smoke test,
  not by unit tests.

## Out of Scope

- Answering permissions or questions from devices (publish-only, per ADR-0001).
- Further Transports (Telegram, Pushover, Matrix, MQTT, SMTP, …): the
  interface invites them; no service is built in this effort.
- iOS/Safari delivery (Android + desktop browsers only).
- The v1 (0.1.2) line and OpenCode 1.x.
- Fan-out to multiple Transports simultaneously (one active Transport only).
- Renaming the repo/npm package; the release publishing procedure (npm
  publish, dist-tags) is documented separately.
- Synchronizing the Subscription Store across hosts beyond the documented
  manual copy.

## Further Notes

- Phase 0 (verifying the web-push library under the plugin runtime) precedes
  all Web Push work; if it fails, ntfy and Gotify ship regardless and Web Push
  is re-planned.
- Glossary terms for this feature live in `GLOSSARY.md` (Transport, Adapter,
  Web Push, Subscription, Bootstrap Service, Subscription Store).
- Notification Kind tags are carried by ntfy and inside the encrypted Web Push
  payload; Gotify has no native tag support (documented in the README).
- Rejected alternatives and their reasons are recorded in ADR-0001; do not
  re-suggest Apprise/Shoutrrr, Telegram/Pushover, or hand-rolled sender crypto
  without new facts.
