# 06: Doku + Release-Vorbereitung 0.3.0

**What to build:** The README describes the full Transport selection: a matrix over the three Transports, per-transport setup guides (ntfy unchanged, Gotify, Web Push including VAPID key generation and Bootstrap Service hosting), the note that the "ntfy" in the repo/npm name is historic, and the changelog/version bump for a non-breaking 0.3.0. A fresh user can follow the README end to end and receive Notifications on their chosen channel.

**Blocked by:** 02 (Gotify Adapter), 04 (Web Push Adapter + Subscription Store), 05 (Bootstrap Service).

**Status:** done

- [ ] README transport matrix plus complete per-transport setup guides (ntfy, Gotify, Web Push incl. VAPID key generation, Bootstrap hosting, same-host caveat, multi-host copy path)
- [ ] "ntfy in the name is historic" note; the exported schema document keeps its name and gains the new sections, documented
- [ ] Config examples in the README validate against the schema document (positive and negative cases)
- [ ] CHANGELOG entry for a non-breaking 0.3.0 and version bump in the package manifest
- [ ] Full test suite, lint, typecheck and build are green
- [ ] Release publishing (npm publish, dist-tags) is NOT part of this ticket — documented separately per spec Out-of-Scope
