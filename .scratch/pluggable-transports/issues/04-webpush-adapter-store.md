# 04: Web Push Adapter + Subscription Store (Publish-Pfad)

**What to build:** Selecting `transport: webpush` with a VAPID config section delivers Notifications to every Subscription in the Subscription Store. The store is read fresh at publish time, so devices come and go without restarting opencode. Failures are isolated per Subscription, expired endpoints (410 Gone) are removed via an atomic store write, every push shows a visible Notification, and the whole fan-out respects the bounded publish deadline. The store is the plugin's first non-startup-validated file: malformed entries are skipped and logged, never fatal.

**Blocked by:** 01 (Transport-Adapter-Layer mit ntfy als aktivem Transport), 03 (Spike: web-push-Lib verifizieren — Go erforderlich).

**Status:** done

- [ ] Fan-out delivers to all store entries; one failing or unreachable endpoint does not stop the others (tested against a local endpoint server with real crypto)
- [ ] Store is read per publish: adding or removing an entry takes effect without a restart
- [ ] A 410 Gone endpoint is removed from the store via an atomic write (temp file + rename, crash-safe)
- [ ] Malformed store entries are skipped with a logged warning and never crash the publish path
- [ ] VAPID subject and keys live in the config section; the private key only via `{env:}`/`{file:}` reference or literal, never logged; missing/invalid values fail startup with an actionable, secret-safe error
- [ ] The whole fan-out respects the bounded publish deadline (same timeoutMs semantics as the other Adapters)
- [ ] Manual demo: hand-written store entry plus config produces a real Notification in a desktop or Android-Chrome browser
- [ ] Inactive/active section validation applies (non-empty webpush section with another transport is a startup error)
