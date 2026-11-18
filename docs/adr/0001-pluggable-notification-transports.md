# Pluggable notification transports (ntfy stays, Gotify and Web Push join)

The plugin shipped with one hard-wired transport (ntfy) whose configuration and
app the owner found confusing, while the actual requirement turned out to be
"TLS plus my own server is fine" — not end-to-end encryption, and extra apps or
servers are acceptable. We introduce a thin TypeScript transport adapter layer
with exactly one active transport per instance (`transport: ntfy | gotify |
webpush`): ntfy stays (no breaking change, released as 0.3.0), Gotify is added
as the simple self-hosted alternative, and Web Push (W3C Push API) is added as
the no-app, no-server option whose payload is encrypted end to end.

## Considered options

- **Apprise / Shoutrrr as meta libraries**: rejected — they live in Python/Go
  runtimes the plugin cannot assume, would run as subprocesses with credentials
  visible in argv, and break the npm/Node distribution model. Their idea is
  realized as thin TS adapters instead.
- **One fixed new transport (e.g. Gotify only)**: rejected — a config enum plus
  per-service sections costs little now and avoids another breaking change
  later.
- **Telegram / Pushover**: rejected — the bot/provider reads message content in
  plaintext; the owner's posture is "third-party cloud for metadata, not for
  content".
- **Hand-rolled RFC 8291/8292 sender crypto**: rejected for Web Push — the
  `web-push` library is used instead, since silent crypto failures are exactly
  the class of "bad experience" this change escapes. This is one deliberate
  runtime dependency.

## Consequences

- Exactly one transport is active per instance; no fan-out across transports.
- Web Push requires a bootstrap path: a small register/deregister service
  shipped with the package and hosted behind the user's reverse proxy, writing
  a subscription store file that the plugin re-reads at publish time, so
  registrations take effect without restarting opencode (opencode only loads
  plugin config at startup).
- The subscription store is the first plugin file that is not strictly
  validated at startup; it needs atomic writes and 410-Gone cleanup.
- iOS/Safari delivery is out of scope (Android + desktop browsers only).
- **Amendment (fork rename):** this repository is now a fork published as
  `opencode-notifications-with-questions`; the "name keeps the historic ntfy"
  consequence above was superseded when the fork was created. The original
  `opencode-ntfy-with-questions` package and repository remain unchanged under
  their own name, and the plugin config/schema/bin names follow the new package
  name.
