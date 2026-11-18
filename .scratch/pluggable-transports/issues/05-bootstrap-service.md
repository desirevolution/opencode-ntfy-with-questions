# 05: Bootstrap Service: Register/Deregister am Proxy

**What to build:** A small register/deregister service ships with the package — one handler plus one page — for hosting behind the user's reverse proxy with TLS. Register: the browser subscribes and POSTs, the service appends a well-formed entry to the Subscription Store. Deregister: the browser unsubscribes and the entry is removed. The service serves only the public VAPID key and Subscription data; there are no accounts and no data beyond Subscriptions.

**Blocked by:** 04 (Web Push Adapter + Subscription Store — das Store-Format muss stehen).

**Status:** done

- [ ] Register flow: subscribe on the page, POST lands, a well-formed entry is appended to the Subscription Store (HTTP tests over real temp files)
- [ ] Deregister flow: unsubscribe plus removal of the entry from the store, verified end to end
- [ ] Malformed POSTs are rejected and duplicate registrations are idempotent; the store is never corrupted
- [ ] The service exposes only the public VAPID key and Subscription data; no secrets, no account data
- [ ] README documents proxy hosting (TLS required for secure context), the same-host/shared-mount caveat, and the multi-host manual copy path
- [ ] Browser-side page JS stays minimal: covered by typecheck and a manual smoke test, not unit tests (per spec testing decisions)
