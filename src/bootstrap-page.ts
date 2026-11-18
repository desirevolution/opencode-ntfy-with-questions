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
<title>opencode notifications</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
button { font: inherit; padding: 0.5rem 1rem; margin: 0 0.5rem 0.75rem 0; }
button:disabled { opacity: 0.5; }
code { word-break: break-all; font-size: 0.75rem; }
#status { min-height: 1.5em; font-weight: 600; }
</style>
</head>
<body>
<h1>opencode notifications</h1>
<p>This page registers this browser as a delivery target for your opencode
session notifications (idle, error, permission and question). Registering
stores one Web Push Subscription on the server this page runs on; no accounts
and no other data are kept. Notifications are shown by this browser only.</p>
<p>
<button id="register" type="button">Register this browser</button>
<button id="deregister" type="button">Deregister this browser</button>
</p>
<p id="status" role="status"></p>
<details>
<summary>Public VAPID key served to browsers</summary>
<p><code id="vapid-key"></code></p>
</details>
<script>
"use strict";
(function () {
  var KEY = "__VAPID_PUBLIC_KEY__";
  var statusEl = document.getElementById("status");
  var registerBtn = document.getElementById("register");
  var deregisterBtn = document.getElementById("deregister");

  function show(text) {
    statusEl.textContent = text;
  }

  function setBusy(busy) {
    registerBtn.disabled = busy;
    deregisterBtn.disabled = busy;
  }

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (json) {
        return { ok: res.ok, json: json };
      }, function () {
        return { ok: false, json: {} };
      });
    });
  }

  function serverError(json, fallback) {
    if (json && typeof json.error === "string" && json.error !== "") return json.error;
    return fallback;
  }

  function failureText(err) {
    var name = err && typeof err.name === "string" && err.name !== "" ? err.name + ": " : "";
    var message = err && typeof err.message === "string" && err.message !== "" ? err.message : String(err);
    return name + message;
  }

  function pushServiceHint(text) {
    return text.indexOf("push service error") !== -1
      ? text + " (your browser could not reach its push service; open chrome://push-internals for details and check DNS blockers or ad blockers for Google's push endpoints)"
      : text;
  }

  function urlB64ToUint8Array(b64) {
    var padding = "=".repeat((4 - (b64.length % 4)) % 4);
    var base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function register() {
    if (!supported()) {
      show("This browser does not support Web Push (desktop Chrome or Android Chrome do).");
      return;
    }
    if (Notification.permission === "denied") {
      show("Notifications are blocked for this site; allow them in the browser's site settings first.");
      return;
    }
    setBusy(true);
    show("Registering ...");
    try {
      var permission = await Notification.requestPermission();
      if (permission !== "granted") {
        show("Notification permission was not granted; nothing was registered.");
        return;
      }
      var reg = await navigator.serviceWorker.register("./service-worker.js");
      var subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(KEY)
      });
      var answer = await post("./register", subscription.toJSON());
      if (!answer.ok) {
        await subscription.unsubscribe();
        show("The server refused the registration: " + serverError(answer.json, "the subscription was not accepted.") + " The subscription was removed from this browser again.");
        return;
      }
      var result = answer.json && answer.json.result;
      if (result === "unchanged") {
        show("This browser was already registered.");
      } else if (result === "replaced") {
        show("Registration for this browser was updated.");
      } else {
        show("This browser is registered for opencode notifications. You can close this page.");
      }
    } catch (err) {
      show("Registration failed: " + pushServiceHint(failureText(err)));
    } finally {
      setBusy(false);
    }
  }

  async function deregister() {
    if (!supported()) {
      show("This browser does not support Web Push (desktop Chrome or Android Chrome do).");
      return;
    }
    setBusy(true);
    show("Deregistering ...");
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      var subscription = reg ? await reg.pushManager.getSubscription() : null;
      if (!subscription) {
        show("This browser holds no push subscription.");
        return;
      }
      var endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      var answer = await post("./deregister", { endpoint: endpoint });
      if (!answer.ok) {
        show("The subscription was removed from this browser, but the server refused the deregistration: " + serverError(answer.json, "the entry may still exist on the server."));
        return;
      }
      show("This browser was deregistered and will no longer receive opencode notifications.");
    } catch (err) {
      show("Deregistration failed: " + failureText(err));
    } finally {
      setBusy(false);
    }
  }

  document.getElementById("vapid-key").textContent = KEY;
  registerBtn.addEventListener("click", function () { void register(); });
  deregisterBtn.addEventListener("click", function () { void deregister(); });

  void (async function () {
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      var subscription = reg ? await reg.pushManager.getSubscription() : null;
      if (subscription) show("This browser holds a push subscription. Use the buttons to keep or remove it.");
    } catch (err) {
      // Leave the neutral status; the buttons still work.
    }
  })();
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
  event.waitUntil(self.registration.showNotification(title, options));
});
`

/** Renders the register/deregister page with the public VAPID key in place. */
export function bootstrapPageHtml(vapidPublicKey: string): string {
  return PAGE_HTML.split(PAGE_KEY_PLACEHOLDER).join(vapidPublicKey)
}

/** The push service worker script served at /service-worker.js. */
export const serviceWorkerJs: string = SERVICE_WORKER_JS
