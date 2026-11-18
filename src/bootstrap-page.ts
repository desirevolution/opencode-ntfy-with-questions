/**
 * The Bootstrap Service's browser side (ADR-0001): one register/deregister
 * page plus the push service worker that displays received pushes.
 *
 * Both are served from strings compiled into `dist/`, so the service ships as
 * one self-contained file with no bundler, no extra files and no runtime
 * dependency beyond Node itself.
 *
 * Browser-side JS stays intentionally minimal and follows the spec's testing
 * decision: covered by typecheck of this module plus a manual smoke test,
 * not by unit tests. The page speaks only relative URLs, so a reverse proxy
 * may mount it under a path prefix (the proxy strips the prefix). No secrets
 * exist here: the only value the page receives is the public VAPID key.
 */

/** Placeholder replaced with the public VAPID key when the page is served. */
const PAGE_KEY_PLACEHOLDER = "__VAPID_PUBLIC_KEY__"

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#14171c">
<title>Notifications · OpenCode</title>
<style>
:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  --bg: #14171c;
  --surface: #1d2128;
  --border: #343a44;
  --text: #eff0f2;
  --muted: #a9b1bc;
  --accent: #d8dfeb;
  --accent-text: #171b20;
  --positive: #8dd4ab;
  --warning: #efbb7d;
  --negative: #f39a9a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); min-height: 100vh; line-height: 1.55; }
main { width: min(100% - 2.25rem, 620px); margin: 0 auto; padding: clamp(2rem, 7vh, 5rem) 0 3rem; }
.header { display: flex; align-items: center; gap: .7rem; margin-bottom: 2rem; color: var(--muted); font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.brand { display: inline-grid; place-items: center; border-radius: .55rem; width: 2rem; height: 2rem; background: #303744; color: #e8edf5; font-size: 1.15rem; font-weight: 700; letter-spacing: 0; }
h1 { font-size: clamp(1.7rem, 4vw, 2.2rem); line-height: 1.2; font-weight: 650; letter-spacing: -.04em; margin: 0 0 .65rem; }
p { margin: 0; }
.intro { color: var(--muted); font-size: .97rem; max-width: 54ch; margin-bottom: 1.5rem; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: .9rem; overflow: hidden; }
.panel-section { padding: 1.35rem; }
.panel-section + .panel-section { border-top: 1px solid var(--border); }
.state-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.kicker { color: var(--muted); font-size: .8rem; font-weight: 600; }
.state-label { display: inline-flex; align-items: center; gap: .48rem; font-weight: 650; font-size: .9rem; }
.dot { background: var(--muted); height: .52rem; width: .52rem; border-radius: 50%; flex-shrink: 0; }
.state-label[data-state="active"] .dot { background: var(--positive); }
.state-label[data-state="warning"] .dot { background: var(--warning); }
.state-label[data-state="error"] .dot { background: var(--negative); }
.state-description { margin-top: .8rem; color: var(--muted); font-size: .91rem; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: 1rem; }
.stat { border-radius: .6rem; background: #262b34; padding: .8rem .9rem; }
.stat dt { color: var(--muted); font-size: .77rem; margin-bottom: .28rem; }
.stat dd { margin: 0; font-size: .92rem; font-weight: 600; overflow-wrap: anywhere; }
.actions { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: .65rem; }
button { font: inherit; min-height: 2.75rem; border: 1px solid var(--border); border-radius: .55rem; padding: .62rem .85rem; cursor: pointer; background: #2a303a; color: var(--text); font-weight: 600; font-size: .88rem; transition: background .15s, border-color .15s; }
button:hover:not(:disabled) { background: #38414e; border-color: #586273; }
button:focus-visible { outline: 2px solid #9bc5fb; outline-offset: 3px; }
button:disabled { cursor: not-allowed; opacity: .4; }
button.primary { color: var(--accent-text); background: var(--accent); border-color: var(--accent); }
button.primary:hover:not(:disabled) { background: #fff; border-color: #fff; }
button.tertiary { background: transparent; }
button.test { grid-column: 1 / -1; }
.feedback { margin-top: .9rem; min-height: 1.4rem; color: var(--muted); font-size: .89rem; overflow-wrap: anywhere; }
.feedback[data-kind="success"] { color: var(--positive); }
.feedback[data-kind="error"] { color: var(--negative); }
.footer { margin-top: 1.3rem; color: var(--muted); font-size: .82rem; }
@media (max-width: 440px) {
  main { width: min(100% - 1.5rem, 620px); padding-top: 2rem; }
  .panel-section { padding: 1rem; }
  .grid, .actions { grid-template-columns: 1fr; }
  button.test { grid-column: auto; }
  .actions button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body>
<main>
  <header class="header"><span class="brand" aria-hidden="true">&gt;_</span><span>OpenCode / Notifications</span></header>
  <h1>Browser notifications</h1>
  <p class="intro">Get updates when your agent finishes, encounters an error, or needs your input. Notifications can arrive even after you close this page.</p>
  <section class="panel" aria-label="Push notification setup">
    <div class="panel-section">
      <div class="state-head">
        <span class="kicker">This browser</span>
        <span id="state-label" class="state-label" data-state="neutral"><span class="dot" aria-hidden="true"></span><span id="state-text">Checking…</span></span>
      </div>
      <p class="state-description" id="state-description">Checking your notification settings.</p>
      <dl class="grid">
        <div class="stat"><dt>Permission</dt><dd id="permission-state">Checking…</dd></div>
        <div class="stat"><dt>Registration</dt><dd id="registration-state">Checking…</dd></div>
      </dl>
    </div>
    <div class="panel-section">
      <div class="actions">
        <button id="register" class="primary" type="button" disabled>Register browser</button>
        <button id="deregister" type="button" disabled>Remove registration</button>
        <button id="test" class="tertiary test" type="button" disabled>Send test notification</button>
      </div>
      <p id="status" class="feedback" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
  </section>
  <p class="footer">The registration applies only to this browser. Remove it here to stop receiving OpenCode push messages on this device.</p>
</main>
<script>
"use strict";
(function () {
  var KEY = "__VAPID_PUBLIC_KEY__";
  var registerBtn = document.getElementById("register");
  var deregisterBtn = document.getElementById("deregister");
  var testBtn = document.getElementById("test");
  var statusEl = document.getElementById("status");
  var stateLabel = document.getElementById("state-label");
  var stateText = document.getElementById("state-text");
  var stateDescription = document.getElementById("state-description");
  var permissionState = document.getElementById("permission-state");
  var registrationState = document.getElementById("registration-state");
  var busy = false;
  var currentSubscription = null;

  function supported() {
    return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  }
  function message(text, kind) {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || "neutral";
  }
  function setState(name, text, description) {
    stateLabel.dataset.state = name;
    stateText.textContent = text;
    stateDescription.textContent = description;
  }
  function updateButtons() {
    var available = supported();
    var subscribed = !!currentSubscription;
    registerBtn.disabled = busy || !available || Notification.permission === "denied";
    deregisterBtn.disabled = busy || !available || !subscribed;
    testBtn.disabled = busy || !available || !subscribed || Notification.permission !== "granted";
    registerBtn.textContent = subscribed ? "Update registration" : "Register browser";
  }
  async function refreshState() {
    if (!supported()) {
      currentSubscription = null;
      permissionState.textContent = "Not available";
      registrationState.textContent = "Not available";
      setState("error", "Unsupported browser", "Web Push requires HTTPS and a compatible browser.");
      updateButtons();
      return;
    }
    var permission = Notification.permission;
    permissionState.textContent = permission === "granted" ? "Allowed" : permission === "denied" ? "Blocked" : "Not requested";
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      currentSubscription = reg ? await reg.pushManager.getSubscription() : null;
    } catch (err) {
      currentSubscription = null;
      message("Could not check browser registration: " + failureText(err), "error");
    }
    registrationState.textContent = currentSubscription ? "Subscribed" : "Not subscribed";
    if (permission === "denied") {
      setState("error", "Permission blocked", "Enable notifications in your browser's site settings, then reload this page.");
    } else if (currentSubscription && permission === "granted") {
      setState("active", "Registered", "This browser holds a push subscription. You can update or remove it at any time.");
    } else {
      setState("warning", "Not registered", permission === "default" ? "Choose Register browser to allow notifications and subscribe." : "Register this browser to start receiving push messages.");
    }
    updateButtons();
  }
  function setBusy(value) { busy = value; updateButtons(); }
  function failureText(err) {
    var name = err && typeof err.name === "string" && err.name ? err.name + ": " : "";
    var detail = err && typeof err.message === "string" && err.message ? err.message : String(err);
    return name + detail;
  }
  function serverError(json, fallback) {
    return json && typeof json.error === "string" && json.error ? json.error : fallback;
  }
  function pushServiceHint(text) {
    return text.includes("push service error")
      ? text + " (your browser cannot reach its push provider; check DNS or content blockers)"
      : text;
  }
  function urlB64ToUint8Array(value) {
    var padding = "=".repeat((4 - (value.length % 4)) % 4);
    var raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function post(path, body) {
    var response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
    var data = await response.json().catch(function () { return {}; });
    return { ok: response.ok, status: response.status, data: data };
  }
  async function register() {
    if (!supported() || busy) return;
    setBusy(true);
    message("Registering this browser…");
    try {
      var permission = await Notification.requestPermission();
      if (permission !== "granted") { message("Permission was not granted. Change your browser settings to allow notifications.", "error"); return; }
      var registration = await navigator.serviceWorker.register("./service-worker.js");
      var subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(KEY)
      });
      var result = await post("./register", subscription.toJSON());
      if (!result.ok) {
        message("Registration failed: " + serverError(result.data, "Server refused this subscription."), "error");
        // Avoid leaving a browser-only subscription that was not accepted by the server.
        if (!currentSubscription) await subscription.unsubscribe();
        return;
      }
      message(result.data.result === "unchanged" ? "Registration is already up to date." : "Browser registered successfully.", "success");
    } catch (err) {
      message("Registration failed: " + pushServiceHint(failureText(err)), "error");
    } finally {
      setBusy(false);
      await refreshState();
    }
  }
  async function deregister() {
    if (busy || !currentSubscription) return;
    setBusy(true);
    message("Removing registration…");
    try {
      var endpoint = currentSubscription.endpoint;
      // Remove the server record first; preserve the subscription if it fails.
      var result = await post("./deregister", { endpoint: endpoint });
      if (!result.ok) { message("Could not remove registration: " + serverError(result.data, "Server error."), "error"); return; }
      await currentSubscription.unsubscribe();
      message("Registration removed. This browser will no longer receive OpenCode pushes.", "success");
    } catch (err) {
      message("Could not remove registration: " + failureText(err), "error");
    } finally {
      setBusy(false);
      await refreshState();
    }
  }
  async function sendTest() {
    if (busy || !currentSubscription || Notification.permission !== "granted") return;
    setBusy(true);
    message("Sending a test notification…");
    try {
      var result = await post("./test", { endpoint: currentSubscription.endpoint });
      if (!result.ok) { message("Test failed: " + serverError(result.data, "Server could not deliver the push."), "error"); return; }
      message("Test push accepted by the provider. Check your system notifications.", "success");
    } catch (err) {
      message("Test failed: " + failureText(err), "error");
    } finally {
      setBusy(false);
      await refreshState();
    }
  }
  registerBtn.addEventListener("click", function () { void register(); });
  deregisterBtn.addEventListener("click", function () { void deregister(); });
  testBtn.addEventListener("click", function () { void sendTest(); });
  // A subscription survives deployment upgrades. Refresh its existing service
  // worker on page load, otherwise old versions may still lack click handling.
  // Do not create a new registration until the user explicitly chooses Register.
  async function refreshWorkerAndState() {
    if (supported()) {
      try {
        var registration = await navigator.serviceWorker.getRegistration();
        if (registration) await registration.update();
      } catch (err) {
        // A temporary worker update failure must not hide the current status.
        message("Could not check for notification updates: " + failureText(err), "error");
      }
    }
    await refreshState();
  }
  void refreshWorkerAndState();
  window.addEventListener("focus", function () { if (!busy) void refreshState(); });
})();
</script>
</body>
</html>
`
const SERVICE_WORKER_JS = `"use strict";
// Push service worker for the opencode notification Bootstrap Service: it
// shows every received push as a visible notification (which is also what
// keeps the browser from revoking the Subscription). The push payload is
// end-to-end encrypted; the browser decrypts it before this handler runs.
self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {};
  }
  var title = typeof data.title === "string" && data.title !== "" ? data.title : "opencode";
  var options = { body: typeof data.message === "string" ? data.message : "" };
  if (Array.isArray(data.tags)) {
    var tags = data.tags.filter(function (tag) { return typeof tag === "string"; });
    if (tags.length > 0) options.tag = tags.join(" ");
  }
  if (typeof data.url === "string") options.data = { url: data.url };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  // Older event payloads and default test pushes may not carry a target.
  // They should still open a useful page instead of silently doing nothing.
  var raw = event.notification.data && event.notification.data.url;
  var target;
  try {
    target = new URL(typeof raw === "string" ? raw : self.registration.scope);
    if (target.protocol !== "https:" && target.protocol !== "http:") return;
  } catch (_) { return; }
  event.waitUntil((async function () {
    var windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < windows.length; i += 1) {
      if (windows[i].url === target.href) {
        await windows[i].focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
`

/** Renders the register/deregister page with the public VAPID key in place. */
export function bootstrapPageHtml(vapidPublicKey: string): string {
  return PAGE_HTML.split(PAGE_KEY_PLACEHOLDER).join(vapidPublicKey)
}

/** The push service worker script served at /service-worker.js. */
export const serviceWorkerJs: string = SERVICE_WORKER_JS
