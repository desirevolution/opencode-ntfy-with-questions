# Changelog

All notable changes to `opencode-notifications-with-questions` are documented here. The
pre-rename history (up to and including the original `0.1.2` v1 line) belongs to
the original project: https://github.com/maboch/opencode-ntfy-with-questions

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package follows semantic versioning; the v1 and v2 lines are intentionally
incompatible (see Version and install separation below).

## [0.3.0] - 2026-11-15

First published release of the v2 line (OpenCode 2.x) and the first release
under the fork's new npm name `opencode-notifications-with-questions`; the
package is renamed from the original `opencode-ntfy-with-questions`
(https://github.com/maboch/opencode-ntfy-with-questions), which remains
unchanged under its own name. The rename moves the plugin config file
(`notification-notifications-with-questions.json`), the packaged JSON Schema
file and the Bootstrap Service bin; existing config content carries over
verbatim. The previously planned `0.2.1` was never published; its OpenCode 2.x
migration is part of this release (listed under Changed). Non-breaking for
plugin configuration: an existing ntfy configuration keeps working verbatim,
`ntfy` remains the default Transport, and unknown keys are still rejected at
startup. The immutable v1 line (`0.1.2`, OpenCode 1.x) is unchanged.

### Fixed

- opencode >= 2.2 compatibility: idle notifications never fired because the
  runtime waited for `session.status` with `status.type === "idle"`, which
  opencode >= 2.2 no longer emits. `session.execution.succeeded` is now the
  primary idle source; the `session.status` idle source stays as a
  de-duplicated secondary for older or TUI-driven contexts, so a single run
  never produces two idle notifications.
- opencode >= 2.2 compatibility: `session.execution.*` events carry no
  `location`, so the runtime's directory filter discarded every completion and
  error event before parsing. The runtime now accepts location-less execution
  events and verifies ownership through the native session lookup (which
  reports the session directory) - on a multi-project machine only the
  instance that owns the session notifies. Lookups that yield no directory
  (older opencode) fail open, as before.

### Changed (v2 line; breaking only relative to the 0.1.2 line)

- Migrated the plugin to the native OpenCode v2 plugin API:
  `Plugin.define({ id, setup })`, with the runtime dependency
  `@opencode/plugin` pinned to `2.0.20`.
- Requires `engines.opencode` `>=2.0.20 <3.0.0` (OpenCode 2.x). The legacy
  0.1.2 line keeps `engines.opencode` `>=1.18.25` and is unchanged.
- Consumes the global OpenCode v2 event stream once and keeps only events whose
  `location.directory` exactly matches the plugin location. The stream is
  volatile: missed events are not replayed.
- Idle notifications now come from `session.status` with `status.type === "idle"`
  (the sole idle source). Errors come from `session.execution.failed` using only
  the error type and message.
- Permission correlation uses the native `requestID` from `permission.replied`
  (matching the `id` on `permission.asked`), preserving request-based correlation.
- Question notifications come exclusively from the `execute.before` tool hook
  filtered by the exact tool name `question`.
- Deprecated or transient native routes are ignored: `session.idle`,
  `session.error`, `session.updated`, `session.step.failed`,
  `session.retry.scheduled` and `question.*` / `form.*`.
- Event-stream dispatch no longer awaits the publish or the subagent
  classification, so a slow lookup or publish cannot delay lifecycle updates or
  a permission reply.
- Removed the "zero runtime dependencies" claim; the SDK dependency is now
  documented.

### Added

- **agent.notify Notification Kind**: the `execute.before` tool hook forwards
  calls of the configured notify tools (`agentNotifyTools`, default
  `opencode_notify` / `openchamber_notify`) as a push, so an explicit
  "notify me when ..." request reaches the phone. Default on, tagged `bell`,
  never suppressed or deduplicated. These tools come from the user's own setup;
  opencode documents no built-in notify tool.
- **Idle enrichment** (`enrichIdleMessages`, default on): idle notifications
  carry the human session title (cached from the session lookup) and the last
  assistant output via `ctx.session.context`, raced against a 2 s deadline;
  failures fall back to the generic message. Widens the transmitted data and is
  documented in the README.
- Transport selection: the `transport` config key (`ntfy` the default,
  `gotify`, `webpush`). Exactly one Transport is active per instance; the
  active section is validated strictly and a non-empty section of an inactive
  Transport is a startup error. New secrets (Gotify app token, VAPID private
  key) are accepted only as a `{env:}`/`{file:}` reference or a literal and are
  never logged.
- Gotify Transport: JSON POST to `<server>/message` with the app token in the
  `X-Gotify-Key` header (never the URL), the plugin's named priority levels
  mapped to Gotify's integer scale (`min`=0, `low`=2, `default`=4, `high`=8,
  `max`=10), and the same bounded, fail-open publish contract as ntfy. ntfy
  tags have no Gotify equivalent and are not transmitted.
- Web Push Transport: deliveries to desktop and Android-Chrome browsers with
  the payload encrypted end to end (RFC 8291 `aes128gcm`, sent via
  `web-push@4.0.0` - the sole new runtime dependency, accepted in ADR-0001).
  Every publish reads the Subscription Store fresh, fans out to every
  Subscription, isolates per-Subscription failures, always shows a visible
  Notification, and removes endpoints reported as gone (HTTP 410/404) with an
  atomic store write; one deadline bounds the whole fan-out.
- Subscription Store: a JSON file written by the Bootstrap Service and read
  fresh at publish time, so registrations take effect without restarting
  opencode. Atomic writes (temp file plus rename); per-publish reads tolerate
  malformed entries by skipping and logging - the plugin's first
  non-startup-validated file, by design.
- Bootstrap Service shipped with the package: the `opencode-notifications-bootstrap`
  bin (a small register/deregister handler plus one page) hosted behind the
  user's TLS reverse proxy, with CLI flags and environment-variable fallbacks;
  it holds no accounts and no data beyond Subscriptions.
- JSON Schema: the exported schema document keeps its name and export path and
  gains the `transport` key plus the `gotify` and `webpush` sections.
- Reconnect backoff on stream EOF or failure: 1, 2, 4, 8, 16, then 30 seconds
  through a single cancellable timer.
- Safety bounds: 64 concurrent idle/error notifications, 64 concurrent
  publishes and 512 pending permission timers. Overflow drops new notifications
  with a fixed secret-safe warning while lifecycle handling and permission
  replies stay responsive.
- Cleanup aborts the stream, cancels the backoff timer and all pending
  permission timers, and prevents any future publish. In-flight HTTP requests
  cannot be retracted.

### Documentation

- README transport matrix and per-transport setup guides (ntfy, Gotify, Web
  Push including VAPID key generation with `npx web-push@4.0.0
  generate-vapid-keys`, Bootstrap Service hosting, the same-host/shared-mount
  caveat, the multi-host manual copy path and per-platform delivery notes);
  the historic "ntfy" in the repo/npm name is documented.
- Version and install separation:
  - v1 `0.1.2` for OpenCode 1.x, configured with the `plugin` key.
  - v2 `0.3.0` for OpenCode 2.x, configured with the `plugins` key.
  - npm dist-tag release plan: `prev` -> `0.1.2`, `latest` -> `0.3.0`. Only
    `latest` = `0.1.2` exists on npm today; there is no `prev` tag and `0.3.0`
    is not published.
- Migration note: the external config file path, JSON Schema and keys are
  unchanged from 0.1.2; v1 users must pin `@0.1.2` or `@prev` before upgrading
  because the bare name and `latest` become the v2 line after the 0.3.0 publish.
- Release procedure documenting the safe order, including creating the `prev`
  tag before `npm publish --tag latest`. Publishing (npm publish, dist-tags,
  git tags) stays a separate documented procedure and is unchanged by this
  release.
- The README's configuration examples are validated against the packaged JSON
  Schema (positive and negative cases) in the test suite.

## [0.1.2] - 2026-09-28

Published to npm. The immutable v1 line for OpenCode 1.x; it is not modified,
unpublished or republished by the 0.2.1 release.

### Added

- Permission notification grace period via `permissionNotificationDelayMs`
  (default `15000` ms): a `permission.asked` notification is delayed and is
  cancelled when a matching `permission.replied` arrives within the window.
- Permission correlation by request ID (independent of the session ID), a
  bounded recently-replied request ID memory (512 entries), and disposal cleanup
  of pending permission timers.

### Notes

- Description: "OpenCode 1.x plugin that publishes idle, error, permission and
  question notifications to ntfy (ntfy.sh or self-hosted)."
- Requires `engines.opencode` `>=1.18.25`; default plugin export is
  `{ id, server }` and uses the `tool.execute.before` hook. Running v1 does not
  require an upgrade.

[Unreleased]: fork repository not published yet - compare links pending
[0.3.0]: fork repository not published yet - compare links pending
