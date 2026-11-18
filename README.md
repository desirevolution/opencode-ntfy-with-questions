# opencode-notifications-with-questions

OpenCode 2.x plugin that publishes notifications when a session needs human
attention:

- a session finishes its run and becomes idle (`session.execution.succeeded`,
  with `session.status` idle as a de-duplicated fallback),
- a session reports an error (`session.execution.failed`),
- opencode asks you to approve a permission (`permission.asked`),
- the agent invokes the built-in `question` tool,
- the agent calls one of your configured notify tools (`agentNotifyTools`).

One **Transport** carries every notification, selected with a single `transport`
config key: `ntfy` (today's behavior, the default), `gotify` (the simple
self-hosted alternative) or `webpush` (straight to desktop and Android-Chrome
browsers, payload encrypted end to end, no app and no server needed). See
[Choosing a transport](#choosing-a-transport).

Subagent (child session) idle/error chatter is suppressed by default so only
notifications that need a human land on your device. The runtime dependencies
are the OpenCode v2 plugin SDK `@opencode/plugin` (pinned to `2.0.20`) and the
`web-push` library (pinned to `4.0.0`, used only by the `webpush` Transport);
HTTP is the platform `fetch` and the rest is Node/Bun built-ins. The plugin
stays publish-only: answering permissions and questions remains a terminal
workflow with every Transport.

### Credits and origin

This package is a fork of
[`opencode-ntfy-with-questions`](https://github.com/maboch/opencode-ntfy-with-questions)
by Maciej Bochynski. The original plugin ships the hard-wired ntfy transport
described above; this fork generalizes it into the selectable
`ntfy`/`gotify`/`webpush` Transport layer (see
`docs/adr/0001-pluggable-notification-transports.md`) and carries the new name
because the plugin is no longer ntfy-specific. Thank you, Maciej, for the
original work.

The original npm package `opencode-ntfy-with-questions` remains unchanged and
available under its own name, including its OpenCode 1.x line (`0.1.2`). This
fork's `package.json` `repository` field still points at the original
repository until the fork has its own published home.

## Choosing a transport

Exactly one Transport is active per instance, selected by the `transport` config
key. The default is `ntfy`, so an upgrade without config changes behaves exactly
as before. Every Transport publishes the same four Notification Kinds with the
same titles, messages and priorities; only the channel differs.

| | `ntfy` (default) | `gotify` | `webpush` |
| --- | --- | --- | --- |
| Hosting model | hosted ntfy.sh, or your own ntfy server | your own Gotify server | your browser vendor's push service, plus a small Bootstrap Service you host for device registration |
| Server you must run | none (or self-host) | yes, one Gotify server binary | only the Bootstrap Service behind your TLS reverse proxy |
| App on the device | ntfy app | Gotify app | none - the browser is the target (Android Chrome, desktop Chromium and Firefox) |
| Who can read the message content | the ntfy server, in plaintext (TLS in transit only) | the Gotify server, in plaintext (TLS in transit only) | nobody but your browser: the payload is encrypted end to end (RFC 8291), the push service sees only ciphertext |
| Secrets in the config | optional access token | app token (required) | VAPID keypair; the private key only via `{env:}`/`{file:}` reference or literal |
| Setup effort | one topic | server URL plus one app token | generate a VAPID keypair, start the Bootstrap Service, register each device once on its page |
| Devices added or removed | fixed topic in config | fixed token in config | devices register and deregister themselves; no opencode restart |

Pick in minutes:

- **Happy with ntfy today?** Change nothing. `ntfy` remains the default and your
  configuration keeps working verbatim.
- **Want a simpler self-hosted setup** with an official, uncluttered app and can
  accept that your own server reads the message content in plaintext? Choose
  `gotify`.
- **Want no app and no always-on push server**, and don't mind hosting a tiny
  register page next to opencode? Choose `webpush` - it is also the only option
  whose message content no third party can read.

Web Push delivery covers Android Chrome and desktop Chromium/Firefox browsers;
iOS/Safari is out of scope.

## Requirements

- OpenCode >= 2.0.20 < 3.0.0 (the `engines.opencode` range)
- Node.js >= 20 or Bun (for development tooling only)

The legacy 0.1.2 line targets OpenCode >= 1.18.25 and does not need upgrading on
its own. See [Versioning and install strategy](#versioning-and-install-strategy).

## Versioning and install strategy

This fork is published under one npm name, `opencode-notifications-with-questions`,
targeting OpenCode 2.x only:

| Line | Version | OpenCode | opencode config key |
| --- | --- | --- | --- |
| this fork (v2) | `0.3.0` | 2.x (>= 2.0.20 < 3.0.0) | `plugins` |

`0.3.0` is the first release of this package and is not published yet. There is
no `prev` tag and no legacy line under this npm name.

The **original project** keeps its own npm name,
`opencode-ntfy-with-questions`, with its own line:

| Line | Version | OpenCode | opencode config key |
| --- | --- | --- | --- |
| original (v1) | `0.1.2` | 1.x (>= 1.18.25) | `plugin` |

`opencode-ntfy-with-questions@0.1.2` works today as an exact, immutable pin on
npm; the original project's dist-tag plan (`latest`/`prev`) applies to that
package, not to this fork. See [Credits and origin](#credits-and-origin).

### OpenCode 2.x (this fork, `0.3.0`)

The following examples are for after the 0.3.0 publication. Add the plugin to
the `plugins` array of your opencode config (`opencode.json` or
`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode-notifications-with-questions@latest"]
}
```

Pin the exact version instead for a deterministic install (available after
publish):

```json
{
  "plugins": ["opencode-notifications-with-questions@0.3.0"]
}
```

CLI alternative:

```sh
opencode plugin add opencode-notifications-with-questions@0.3.0
# or, after publish: opencode plugin add opencode-notifications-with-questions@latest
```

### OpenCode 1.x (original project, `0.1.2`)

OpenCode 1.x is covered by the original project's v1 line, which uses the
`plugin` key (singular) and the original npm name:

```json
{
  "plugin": ["opencode-ntfy-with-questions@0.1.2"]
}
```

That pin works today; it ships the original hard-wired ntfy transport only.

After installing either line, create the plugin config file described below and
**restart opencode**. OpenCode only loads plugins and their configuration at
startup - config or plugin changes are not picked up until the next restart.

### Do not mix `plugin` and `plugins`

Never put both `plugin` and `plugins` entries in the same config, and never add
two entries for this package. Use the key that matches your OpenCode major
version with a single specifier.

### What changes after the 0.3.0 publish

Before the first publish, the npm name `opencode-notifications-with-questions`
resolves to nothing. Once `0.3.0` is published with `--tag latest`, the bare
name and the `latest` tag resolve to this fork's OpenCode 2.x line. The
original package `opencode-ntfy-with-questions` is unaffected: its name, its
`0.1.2` artifact, its dist-tags and its git tag are never modified.

## Migrating from the original 0.1.2 (v1) to 0.3.0 (v2)

The v2 plugin keeps the same external configuration contract. Moving from the
original v1 line to this fork also means upgrading OpenCode from 1.x to 2.x,
installing the new package name and renaming the opencode config key from
`plugin` to `plugins`; apart from that, the configuration content is unchanged:

- Rename the config file (the fork follows the new package name):
  `$XDG_CONFIG_HOME/opencode/notification-ntfy-with-questions.json` becomes
  `$XDG_CONFIG_HOME/opencode/notification-notifications-with-questions.json`
  (same under `~/.config/opencode/` when `XDG_CONFIG_HOME` is unset).
- Same JSON Schema keys (`enabled`, `events`, `suppressSubagents`,
  `permissionNotificationDelayMs`, `ntfy`). No config rewrite is needed.
  0.3.0 adds the optional `transport`, `gotify` and `webpush` keys on top; an
  existing ntfy-only configuration keeps working verbatim (`ntfy` remains the
  default Transport).
- The v2 plugin does not use the plugin-context `options` / `storage` fields as
  a new configuration source; configuration stays in the external JSON file.
- In the opencode config, set the `plugins` specifier to
  `opencode-notifications-with-questions@latest` or `@0.3.0`.
- Restart opencode after the change.

API references:
[plugins](https://opencode.ai/v2/docs/plugins) and
[migrate from v1](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Remove the old opencode-ntfy.sh plugin

If a previous `opencode-ntfy.sh` plugin is still listed, remove or disable it in
the opencode plugin array. Keeping both this plugin and the old
`opencode-ntfy.sh` entry produces duplicate notifications.

## Configuration

The plugin reads a separate config file that is intentionally NOT
backward-compatible with any older `notification-ntfy.json`:

- `$XDG_CONFIG_HOME/opencode/notification-notifications-with-questions.json`
- when `XDG_CONFIG_HOME` is not set: `~/.config/opencode/notification-notifications-with-questions.json`

The JSON Schema for editor validation is packaged with the plugin at
`notification-notifications-with-questions.schema.json` (also exported as
`opencode-notifications-with-questions/notification-notifications-with-questions.schema.json`).
Since 0.3.0 the schema carries the `transport` key and the per-Transport
sections `gotify` and `webpush` next to `ntfy`; unknown properties are still
rejected by both the schema and the runtime validator. Coming from the original
plugin (or a pre-rename checkout), rename your config file to the new name and
point your editor at the new schema path.

The `transport` key selects the active Transport (default `ntfy`). Exactly one
Transport is active per instance; the active section is validated strictly, and
a non-empty section of an inactive Transport is rejected at startup.

### Minimal example (ntfy.sh)

```json
{
  "ntfy": {
    "topic": "my-opencode-alerts"
  }
}
```

### Complete example (hosted)

```json
{
  "$schema": "./node_modules/opencode-notifications-with-questions/notification-notifications-with-questions.schema.json",
  "enabled": true,
  "events": {
    "session.idle": true,
    "session.error": true,
    "permission.asked": true,
    "question.asked": true
  },
  "suppressSubagents": {
    "session.idle": true,
    "session.error": true
  },
  "permissionNotificationDelayMs": 15000,
  "ntfy": {
    "server": "https://ntfy.sh",
    "topic": "my-opencode-alerts",
    "token": "tk_my_access_token",
    "priority": "default",
    "timeoutMs": 5000
  }
}
```

### Self-hosted example (with auth via environment variable)

```json
{
  "ntfy": {
    "server": "https://ntfy.example.com",
    "topic": "opencode",
    "token": "{env:NTFY_TOKEN}"
  }
}
```

### Secrets from files

```json
{
  "ntfy": {
    "topic": "opencode",
    "token": "{file:~/secrets/ntfy-token.txt}"
  }
}
```

`{file:...}` paths may be absolute, start with `~/`, or be relative to the
directory containing the config file. Referenced file content is trimmed and
capped at 16 KiB; the config file itself is capped at 64 KiB.

Substitutions are full-value only: a valid `{env:NAME}` or `{file:path}`
reference must be the entire JSON string value. Interpolation such as
`"prefix-{env:NAME}"`, multiple references in one string, or empty/malformed
references are rejected at startup with a fixed, secret-safe error; ordinary
strings that merely contain unrelated braces are left untouched.

### ntfy setup

`ntfy` is the default Transport and needs no `transport` key; the `ntfy` section
is required when it is active (the examples above are complete ntfy
configurations). Its behavior is unchanged since the first release:

- `ntfy.server` defaults to `https://ntfy.sh`; self-hosted instances and
  reverse-proxy path prefixes are supported (see
  [Reverse-proxy prefix caveat](#reverse-proxy-prefix-caveat) below).
- `ntfy.topic` is required (1-64 characters from `A-Z a-z 0-9 - _`); an optional
  `ntfy.token` is sent as `Authorization: Bearer ...` and never logged.
- `ntfy.priority` is one of `min`, `low`, `default`, `high`, `max`, mapped to
  ntfy's numeric scale 1-5 (`min`=1 ... `max`=5).
- `ntfy.timeoutMs` (default 5000, 1-60000) bounds one publish.
- Every Notification carries its fixed kind tag (`hourglass_done`, `warning`,
  `lock`, `question`) in the request body - see
  [Event and suppression behavior](#event-and-suppression-behavior).

### Gotify setup
Set `transport` to `gotify` and fill the `gotify` section. The plugin then
POSTs JSON to `<server>/message` and authenticates with the app token in the
`X-Gotify-Key` request header - the token is never placed in the URL and never
logged. Exactly one transport is active per instance; a non-empty section of
the inactive transport is rejected at startup.

```json
{
  "transport": "gotify",
  "gotify": {
    "server": "https://gotify.example.com",
    "token": "{env:GOTIFY_TOKEN}",
    "priority": "high"
  }
}
```

Setup on the Gotify side: run your Gotify server, create an application in its
web UI ("Apps"), and use that application token as `gotify.token`. The token is
required; it may be a plain literal without reference markers or one full-value
`{env:...}`/`{file:...}` reference, and is never logged.

`gotify.server` follows the same URL rules as `ntfy.server`: http(s) with a
DNS/IPv4/localhost/bracketed-IPv6 host, an optional canonical port and an
optional reverse-proxy path prefix; credentials, whitespace, query strings and
fragments are rejected. A trailing slash is added when missing and the client
appends `message`, so a path prefix keeps working and messages land on
`https://gotify.example.com/<prefix>/message`.

### Gotify priority mapping
The plugin's named priority levels (shared with ntfy) map to Gotify's integer
priority scale:

| Config value | Gotify priority |
| --- | --- |
| `min` | `0` |
| `low` | `2` |
| `default` | `4` |
| `high` | `8` |
| `max` | `10` |

The mapped value is higher for more urgent notifications, so your Gotify app
can distinguish an idle session from a permission prompt by the configured
`gotify.priority`.

### Web Push setup

Set `transport` to `webpush` and fill the `webpush` section. The plugin then
encrypts every Notification end to end (RFC 8291 `aes128gcm`) and hands it to
the browser vendor's push service, which sees only ciphertext - no app and no
ntfy/Gotify server is needed. The sender uses the `web-push` library, pinned to
`4.0.0`. iOS/Safari is not supported; Android Chrome and desktop
Chromium/Firefox are.

**1. Generate a VAPID keypair** with the documented web-push tooling, pinned to
the version this package ships:

```sh
npx web-push@4.0.0 generate-vapid-keys --json
```

Keep the printed private key secret: never commit it, never log it. The plugin
checks at startup that the two keys form a matching pair, so a typo in either
fails fast with an error naming the offending key (values are never echoed).

**2. Configure the plugin**:

```json
{
  "transport": "webpush",
  "webpush": {
    "subject": "mailto:you@example.com",
    "publicKey": "BPt_voDSmIATroEzyJKd-qO52f2IDeHKjv6elEw3u-B-IHlw7NZEwuYu3f9HwD3g6nh5B5VZW7OKsfubd9r3bKk",
    "privateKey": "{env:VAPID_PRIVATE_KEY}",
    "storePath": "/srv/opencode/subscriptions.json"
  }
}
```

Replace `publicKey` with the key you generated and provide `privateKey` as one
full-value `{env:...}`/`{file:...}` reference (shown above) or as a plain
literal - it is never logged. The example key here only illustrates the shape;
use your own. `subject` is the VAPID contact URI (a `mailto:` or `https://`
address carried in the push-service-facing JWT). `storePath` is the
[Subscription Store](#bootstrap-service-web-push-device-registration) file
shared with the Bootstrap Service; use an absolute path. The optional
`webpush.timeoutMs` (default 5000, 1-60000) bounds one whole publish fan-out
across all Subscriptions, not each request.

**3. Start the Bootstrap Service and register a device** by opening its page
once per browser. The service hands your public VAPID key to the browser,
creates the Subscription, and appends it to the store file; deregistration
happens on the same page. Hosting behind your TLS reverse proxy (including the
same-host/shared-mount requirement and the manual copy path for a second
opencode host) is documented in the next section,
[Bootstrap Service (Web Push device registration)](#bootstrap-service-web-push-device-registration).
Registrations take effect at the next publish without restarting opencode.

**At publish time** the plugin reads the store fresh, fans the Notification out
to every Subscription, and isolates per-Subscription failures so one dead
device never stops the others. Endpoints the push service reports as gone
(HTTP 410, or 404) are removed from the store with an atomic write. Every push
carries the visible Notification content - silent pushes would get the
Subscription revoked.

**Delivery while the browser is closed** depends on the platform:

- **Android Chrome**: delivered through the system push channel with the
  browser not open; no PWA install is needed (the Bootstrap page registers its
  own service worker). If you force-stop Chrome from the recent-apps screen,
  delivery pauses until Chrome runs again.
- **Chromium on Windows**: delivered while the browser is closed, via the
  Windows push channel.
- **Firefox on the desktop, and Chromium on Linux/macOS**: the browser must be
  running - a background process with no window open is enough.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to keep the plugin loaded but send nothing. |
| `events` | all `true` | Toggles per notification kind: `session.idle`, `session.error`, `permission.asked`, `question.asked`, `agent.notify`. |
| `agentNotifyTools` | `["opencode_notify", "openchamber_notify"]` | Tool names whose `execute.before` calls are forwarded as `agent.notify` notifications. These tools come from your own setup (an MCP server or another plugin) - opencode itself documents no built-in notify tool. Entries: 1-64 characters, no duplicates, at most 16. |
| `enrichIdleMessages` | `true` | Include the human session title and the last assistant output in idle notifications (best-effort with a 2 s deadline; failures fall back to the generic message). Widens the transmitted data - see [What data is transmitted](#what-data-is-transmitted). |
| `suppressSubagents` | both `true` | Suppress `session.idle` / `session.error` notifications for known subagent sessions. |
| `permissionNotificationDelayMs` | `15000` | Grace period in ms (integer `0`-`300000`) before a `permission.asked` notification is published. A matching `permission.replied` within the window suppresses it. `0` publishes immediately. |
| `ntfy.server` | `https://ntfy.sh` | Base URL, http(s), DNS/IPv4/localhost/bracketed-IPv6 host, optional canonical port, optional reverse-proxy path prefix. Credentials, whitespace, query strings and fragments are rejected. May instead be one full-value `{env:...}`/`{file:...}` reference. |
| `ntfy.topic` | (required) | 1-64 characters from `A-Z a-z 0-9 - _`, or one full-value reference. |
| `ntfy.token` | none | Sent as `Authorization: Bearer ...`. Never logged. A plain literal without reference markers, or one full-value reference. |
| `ntfy.priority` | `default` | One of `min`, `low`, `default`, `high`, `max`. |
| `ntfy.timeoutMs` | `5000` | Per-publish deadline, 1-60000 ms. Only bounds ntfy publishing, not session lookups. |
| `transport` | `ntfy` | The active Transport: `ntfy`, `gotify` or `webpush`. Exactly one is active per instance. |
| `gotify.server` | (required) | Gotify base URL, same rules as `ntfy.server`; the client POSTs to `<server>/message`. May instead be one full-value `{env:...}`/`{file:...}` reference. |
| `gotify.token` | (required) | Gotify application token, sent as the `X-Gotify-Key` header. Never logged. A plain literal without reference markers, or one full-value reference. |
| `gotify.priority` | `default` | One of `min`, `low`, `default`, `high`, `max`, mapped to Gotify's integer scale (see above). |
| `gotify.timeoutMs` | `5000` | Per-publish deadline, 1-60000 ms. Only bounds Gotify publishing, not session lookups. |
| `webpush.subject` | (required) | VAPID subject: a `mailto:` or `https://` contact URI carried in the push-service-facing JWT. |
| `webpush.publicKey` | (required) | VAPID public key: base64url-encoded 65-byte uncompressed P-256 point, as emitted by `npx web-push generate-vapid-keys --json`. Not a secret; the same value is configured for the Bootstrap Service. |
| `webpush.privateKey` | (required) | VAPID private key: base64url-encoded 32 bytes matching `publicKey` (verified at startup). A secret: plain literal or one full-value reference; never logged. |
| `webpush.storePath` | (required) | Path of the Subscription Store file written by the Bootstrap Service and read fresh at publish time. |
| `webpush.timeoutMs` | `5000` | Deadline, 1-60000 ms, bounding one whole publish fan-out across all Subscriptions - not each request. Only bounds webpush publishing, not session lookups. |

Unknown properties anywhere in the file are rejected at startup, both by the
runtime validator and by the JSON Schema. A missing config file, invalid JSON,
an unresolved `{env:...}` / `{file:...}` reference, or invalid required fields
fail plugin initialization with an actionable error message. Error messages
never print substituted values, secrets or file contents - only key names,
variable names and paths.

### Extra Web Push features (Dev-Environment port)

This fork also supports a dark, mobile-friendly browser registration page with
registration state, a **Send test notification** button, and clickable push
notifications that reopen the corresponding OpenCode Web session.

To enable click destinations, set these **optional keys** in the plugin's
`webpush` configuration (fragment, not a complete config):

```jsonc
"webUiBaseUrl": "https://code.example.com/",
"webUiServerUrl": "http://127.0.0.1:4096/"
```

`webUiBaseUrl` is the public browser URL. `webUiServerUrl` is the exact
connection URL OpenCode Web encodes into its `/server/<base64url>/session/<id>`
paths. The second value is optional and defaults to the public URL. Determine
it from one known-working session link rather than guessing. Both options
reject credentials, query strings, and fragments. Without `webUiBaseUrl`,
push notifications still work, but click targets fall back to the registration
page.

The optional test route is enabled only when the bootstrap service can read
the VAPID private key **from a file** and has a valid VAPID subject. Supply:

```sh
OPENCODE_NTFY_VAPID_PRIVATE_KEY_FILE=/path/to/vapid-private-key \
OPENCODE_NTFY_VAPID_SUBJECT=mailto:admin@example.com \
OPENCODE_NTFY_TEST_URL=https://code.example.com/ \
  opencode-notifications-bootstrap \
    --store /path/to/webpush-subscriptions.json \
    --vapid-public-key "<public key>"
```

`POST /test` accepts an existing registered endpoint only, and rate-limits
each endpoint to one attempt every 15 seconds. A response `accepted` means the
push provider accepted the message, **not** that the browser displayed it.
Keep the registration service behind HTTPS and authenticated reverse-proxy
access (for example, Caddy + Authelia). The service itself has no login.

## Bootstrap Service (Web Push device registration)

The Web Push transport registers devices on a small register/deregister
service that ships with this package. It holds no accounts and no data beyond
Subscriptions: the only things it serves are the public VAPID key and a
register/deregister page. The private VAPID key is never accepted by the
service - it stays in the plugin config on the opencode host.

The service writes the same Subscription Store file the plugin reads
(`webpush.storePath`), so registrations take effect at the next publish
without restarting opencode.

### Hosting behind your reverse proxy with TLS

Browsers only offer the Push API in secure contexts, so the page must be
reached over HTTPS: keep the service on a loopback/private interface and put
your TLS reverse proxy in front of it. The service binds `127.0.0.1:8089` by
default.

Start it next to your opencode instance, pointing at the store file and the
public key from the plugin config (`webpush.storePath`, `webpush.publicKey`):

```sh
node node_modules/opencode-notifications-with-questions/dist/bootstrap-service.js \
  --store /srv/opencode/subscriptions.json \
  --vapid-public-key "<webpush.publicKey value>"
```

After a global install the same command is available as
`opencode-notifications-bootstrap`; every flag also reads from an environment
variable, which keeps the key out of shell history:

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--store <path>` | `OPENCODE_NTFY_SUBSCRIPTION_STORE` | (required) |
| `--vapid-public-key <key>` | `OPENCODE_NTFY_VAPID_PUBLIC_KEY` | (required) |
| `--host <addr>` | `OPENCODE_NTFY_HOST` | `127.0.0.1` |
| `--port <n>` | `OPENCODE_NTFY_PORT` | `8089` |

An nginx site that fronts it with TLS (`http2` optional):

```nginx
server {
  listen 443 ssl;
  server_name push.example.com;
  # ssl_certificate / ssl_certificate_key here
  location / {
    proxy_pass http://127.0.0.1:8089;
    proxy_set_header Host $host;
  }
}
```

With Caddy the equivalent is one line: `push.example.com {
reverse_proxy 127.0.0.1:8089 }`. The page uses relative URLs only, so a
reverse-proxy path prefix keeps working if your proxy strips the prefix (see
"Reverse-proxy prefix caveat" below for the general caveat).

The service answers on four routes: `GET /` (the page),
`GET /service-worker.js` (the page's push worker), `POST /register` (the
browser's `PushSubscription.toJSON()`), and `POST /deregister`
(`{"endpoint": "https://..."}` after the browser unsubscribed itself). The
page has one register and one deregister control and reports honestly what
the server answered; nothing else is exposed.

### Same host or shared mount

The service and the plugin must see the same Subscription Store file: run the
service on the same host as opencode, or point both at a file on a shared
mount. Both sides write atomically (temp file plus rename) and never corrupt
the file, but they are separate processes - if opencode cleans up an expired
Subscription at the exact moment the service rewrites the store, the last
writer wins. In practice this window is negligible; avoid deregistering in
the middle of a burst of notifications.

If the store file is unreadable, unparsable or not a JSON array, the service
refuses the change instead of overwriting it (and tells you so on the page);
fix the file, or delete it to start with an empty store on the next
registration.

### Multiple opencode hosts: manual copy

Subscriptions are not synchronized across hosts. To deliver on a second
opencode instance, copy the store file (or just the one entry) to that
instance's `webpush.storePath` while it is idle, e.g.
`scp subscriptions.json second-host:/srv/opencode/subscriptions.json`. The
copied entry takes effect at that instance's next publish without a restart;
a browser can be registered on several instances at once. Keep the copy
atomic on the target (`scp` to a temp name and `mv` it into place) so a
half-written file is never read.

## Event and suppression behavior

The plugin subscribes once to the global opencode v2 event stream. The stream is
shared across server locations, so the plugin keeps only events whose
`location.directory` exactly equals the plugin's own location directory
(`ctx.location.directory`); events without a matching location are ignored.
Exception: `session.execution.*` events carry no location in opencode >= 2.2,
so they pass without one and the plugin verifies ownership through the native
session lookup, which reports the session's owning directory - on a
multi-project machine only the instance that owns the session notifies. The
stream is volatile: there is no replay of events missed while disconnected.

Recognized native events:

- `session.created` / `session.deleted` maintain an in-memory
  `sessionID -> parentID` cache. `session.created` carries a flat payload with
  the session ID and an optional `parentID`. `session.deleted` removes the
  entry; a later event for the same session is unknown again and may start a
  fresh fallback lookup.
- Idle: `session.execution.succeeded` is the primary source (opencode >= 2.2
  emits the run completion this way and never emits `session.status` idle).
  `session.status` with `status.type === "idle"` stays a de-duplicated
  secondary source for older or TUI-driven contexts: whichever source published
  first marks the session, and the secondary source is dropped within a short
  window, so one run never produces two idle notifications.
- Error: `session.execution.failed`. Only the error `type` and its message are
  used; the transient `session.step.failed` / `session.retry.scheduled` frames
  and the legacy `session.error` event are ignored.
- `permission.asked` uses `action` as the permission name, `resources` as the
  affected patterns and `id` as the request identifier.
- `permission.replied` correlates on the native `requestID` (the same value as
  the `id` on the corresponding ask); there is no legacy fallback.
- `question.*` / `form.*` runtime events are ignored: question notifications
  come exclusively from the `execute.before` tool hook filtered by the exact
  tool name `question`, so one question produces exactly one notification.
- `agent.notify`: the `execute.before` hook also forwards calls of the tools
  listed in `agentNotifyTools` (default `opencode_notify` /
  `openchamber_notify`; these tools come from your own setup). An explicit
  agent notify request publishes its title/body as a push - it is never
  suppressed or deduplicated.
- `session.updated` is not emitted in v2 and is ignored if it appears.

On idle / error the cache is consulted first. On a cache miss the plugin calls
the native session lookup (`ctx.session.get`) as a fallback and records the
result; the same shared lookup also answers the ownership check for
location-less execution events. Suppression only happens when a parent session
is known to exist. Ownership decisions fail open: a lookup that yields no
directory (older opencode, transport failure) notifies anyway.

- Fallback lookups are bounded: each lookup races the native session lookup
  against a fixed 5000 ms deadline, and concurrent misses for the same session
  share one lookup. A timeout is treated like any lookup failure.
- If the fallback lookup fails (API error, unknown session, transport failure,
  deadline), the plugin fails open: it sends the notification and logs a
  sanitized warning that names only the session.
- An error event without a `sessionID` always notifies.
- `permission.asked` notifications are sent for root and child sessions alike,
  but only after a grace period (see below). Question notifications are always
  sent, including from subagents.
- The event stream dispatches each accepted frame without awaiting the publish
  or the subagent classification, so a slow session lookup or a slow Transport
  can never delay lifecycle updates or a permission reply.
- Question notifications do await their bounded publish (at most the active
  Transport's `timeoutMs`) because the `execute.before` tool hook awaits them;
  publish failures are logged and swallowed and can never prevent the question
  tool from running.
- OpenCode emits the terminal idle status only after the full run finishes,
  never while a question is waiting for an answer, so idle and question
  notifications do not duplicate each other.
- Idle notifications are enriched best-effort with the human session title
   (cached from the session lookup) and the last assistant output
   (`ctx.session.context`, raced against a 2 s deadline); any failure or
   timeout falls back to the generic message. `enrichIdleMessages: false`
   disables the enrichment and its extra lookup.
- agent.notify notifications are explicit agent requests: they are never
   suppressed, classified or deduplicated, and their title/body are
   agent-controlled text (sanitized and truncated by the active Transport).

Notification titles contain the project basename (the directory the opencode
instance runs in). Tags are fixed: idle `hourglass_done`, error `warning`,
permission `lock`, question `question`, notify `bell`. How the tags travel per Transport is
described in [What data is transmitted](#what-data-is-transmitted).

### Stream robustness

- On a stream EOF or subscription failure the plugin re-subscribes through one
  cancellable backoff timer with delays of 1, 2, 4, 8, 16 and then 30 seconds.
  The timer never keeps the process alive.
- Plugin cleanup aborts the stream, cancels the backoff timer and every pending
  permission timer, and prevents any future publish. An HTTP request already in
  flight cannot be retracted.
- Safety bounds: at most 64 concurrent idle/error notifications, 64 concurrent
  publishes and 512 pending permission timers. When a bound is reached, new
  notifications are dropped with a fixed secret-safe warning; lifecycle handling
  and permission replies stay responsive.

### Permission notification grace period

A `permission.asked` notification is delayed by `permissionNotificationDelayMs`
(15000 ms by default). If a matching `permission.replied` event arrives within
that window, the pending notification is cancelled and nothing is published.
OpenCode may auto-approve a request it did ask about, and the user may answer
quickly in the terminal; a `permission.replied` then arrives before the grace
period elapses and the push notification would be noise. This is distinct from
permissions already allowed by a standing rule: those never emit a
`permission.asked` event at all, so no notification is scheduled for them.

- Correlation uses the permission request ID, never the session ID, so several
  concurrent requests in the same session are tracked independently.
- A duplicate `permission.asked` for a request that is already pending is
  ignored: the notification is neither duplicated nor rescheduled.
- A reply that arrives before its ask event is remembered (up to 512 request
  IDs) and still suppresses the notification once the ask is seen.
- A request without a usable ID is still notified after the grace period, but
  it cannot be correlated with a reply. Such pending timers are tracked and
  cancelled when the plugin is disposed.
- A reply after the grace period cannot retract a notification that was already
  sent; it is too late by design.
- This is a heuristic. OpenCode does not expose its auto-approve mode to
  plugins, so the plugin cannot know in advance whether a request will be
  answered automatically and relies purely on the reply event arriving in time.
- Set `permissionNotificationDelayMs` to `0` to publish immediately without a
  grace timer. The publish starts as soon as the `permission.asked` frame is
  seen, but there is no returned v2 event hook that awaits it: the global event
  stream keeps dispatching non-blocking, so a slow publish never delays
  lifecycle updates or a permission reply. Only the `question` tool hook awaits
  its bounded publish.

## What data is transmitted

Every Transport sends the same four Notification Kinds with the same titles and
message content; only the request shape differs.

With `transport: ntfy` (the default), requests are JSON POSTs to the configured
base URL with the topic in the body (never in the URL),
`Content-Type: application/json`, optional `Authorization: Bearer ...`, and
body fields `topic`, `title`, `message`, `priority`, `tags`.

With `transport: gotify`, requests are JSON POSTs to `<server>/message` with
`Content-Type: application/json`, the application token in the `X-Gotify-Key`
header (never in the URL), and body fields `title`, `message`, `priority`. The
same four notification kinds and the same body content are sent; ntfy `tags`
have no equivalent in this request shape and are not transmitted.

With `transport: webpush`, the plugin sends one encrypted POST per Subscription
to each Subscription's push-service endpoint: an RFC 8291 `aes128gcm` envelope
around a JSON document with `kind`, `title`, `message` and the same fixed
`tags` as ntfy. The push service sees only ciphertext; endpoint URLs (they
carry the subscription's secret token), key material and payload content are
never logged. Pushes expire from the push service after one hour (TTL).

- Idle: the project name, the session ID, and a completion/waiting message.
  With `enrichIdleMessages` on (the default) the message additionally carries
  the human session title and the last assistant output - the assistant output
  is agent-generated content, so on ntfy.sh it reaches a third party. Set
  `enrichIdleMessages: false` to keep the generic message.
- Error: the project name, the session ID (when present), and the native error
  `type` plus its `message` only. Stacks, response bodies, headers and provider
  IDs are never included.
- Permission (after the grace period): the project name, the session ID (when
  present), the permission type and the requested patterns.
- Question: the project name plus every question with its header, its options
  (labels and descriptions) and whether multiple answers are allowed. If the
  question payload is malformed, a generic "open the conversation" message is
  sent instead of failing the tool call.
- agent.notify: the project name plus the notify tool's title and body. Both
  are agent-controlled text: the agent decides what is sent, and the active
  Transport truncates and sanitizes it like every other notification.

The title is bounded to 1024 bytes and the message to 4096 UTF-8 bytes with
deterministic UTF-8-safe truncation; unsafe control characters are removed
from the title. Message content is never placed in HTTP headers. For webpush
the plaintext payload must additionally fit the push services' 4096-byte
encrypted-body limit: the plugin keeps it below 3990 bytes by shrinking an
oversized message, reserving the envelope and record overhead.

## Reverse-proxy prefix caveat

If your self-hosted ntfy sits behind a reverse proxy under a path (for example
`https://ntfy.example.com/notify/`), set `ntfy.server` to that full base URL
including the prefix. The prefix is preserved and every publish is a JSON POST
to that exact base URL with the topic in the body. The proxy must route that
path to ntfy and must not strip the JSON body. Do not append the topic to the
URL yourself.

## Troubleshooting

- **No notifications**: restart opencode after changing config or installing
  the plugin. Verify the file name and location (see above). Check opencode's
  log output - plugin and notification problems are logged with the prefix
  `[opencode-notifications-with-questions]` and never contain your token.
- **Notifications are duplicated**: you still have the old `opencode-ntfy.sh`
  (or another notification plugin) active, or two entries for this package.
  Remove the extra entry.
- **Duplicate question notifications**: only the v2 `execute.before` tool hook
  (the v1 `tool.execute.before` hook) is used. If you see two, another plugin
  is also watching the `question` tool.
- **Subagent notifications still arrive**: the session was never seen by a
  `session.created` event and the fallback lookup could not classify it, or
  `suppressSubagents` is disabled. The plugin logs a classification warning in
  that case.
- **Plugin fails to load**: the config file is missing, not valid JSON,
  references an unset environment variable or unreadable file, or contains an
  invalid field. The error message tells you exactly which key, variable or
  path is at fault; fix it and restart opencode.
- **Config not validated by the editor**: point `$schema` at the packaged
  `notification-notifications-with-questions.schema.json` (see the complete example).
- **Requests time out**: the configured server is unreachable from your machine
  or the `timeoutMs` budget is too small. Notification failures never crash a
  session and never block the question tool.
- **No webpush notifications**: register a device on the Bootstrap Service page
  and confirm the store file exists at `webpush.storePath`. The log line
  `webpush publish skipped: subscription store ... has no subscriptions` means
  the store is empty or unreadable - registrations take effect at the next
  publish without restarting opencode. On Android, force-stopping Chrome pauses
  delivery; on desktop Firefox and Chromium on Linux/macOS the browser must be
  running in the background (see the Web Push setup section).
- **A webpush device keeps failing**: the log names the HTTP status per
  Subscription (endpoints are never logged). An expired device is removed
  automatically (HTTP 410/404); simply re-register it on the Bootstrap page.

## Development

```sh
bun install            # install dev dependencies (frozen lockfile in CI)
bun run lint           # ESLint over src/ and tests/
bun run typecheck      # tsc --noEmit
bun run test           # vitest
bun run build          # emit dist/ (ESM + declarations)
npm pack --dry-run     # inspect the published package contents
```

The package publishes `dist/`, the JSON Schema, `README.md` and `LICENSE`.
Source files import the OpenCode v2 plugin SDK `@opencode/plugin` (pinned to
`2.0.20`) and, for the webpush Transport only, the `web-push` library (pinned
to `4.0.0`); everything else the runtime uses is the platform `fetch` or
Node/Bun built-ins. Lint, TypeScript, vitest and the AJV-based schema checks
live in `devDependencies`.

Run the commands above before every release; an installed-tarball smoke test is
also required before publishing.

## Releasing

Publish from the `main` branch and run the checks in this order. This fork has
exactly one npm line: `0.3.0` is the first release, so there is no `prev` tag
to create and nothing to protect on the bare name. (The original project's
`prev` -> `0.1.2` plan applies to the `opencode-ntfy-with-questions` npm name,
not to this fork.) Run:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
npm pack --dry-run
npm publish --tag latest          # publishes the 0.3.0 manifest
npm dist-tag ls opencode-notifications-with-questions
npm view opencode-notifications-with-questions@latest version
```

Expected after a successful publish: `latest` = `0.3.0`. Dist-tags are mutable
pointers and are not created automatically; published versions are immutable.
Never republish or unpublish a released version, and never move a release git
tag. To work on the original project's legacy line, check out its `v0.1.2` tag
in a separate clone of the original repository.

## License

MIT - see [LICENSE](LICENSE).
