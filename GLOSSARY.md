# opencode-notifications-with-questions

Domain language for the plugin: it watches OpenCode session events and turns the
ones needing human attention into notifications on the user's devices.

## Language

**Notification**:
A message the plugin publishes when a session needs human attention.
_Avoid_: alert, push

**Notification Kind**:
One of the five classes that decide when a Notification is published: idle, error, permission, question, notify.
_Avoid_: event type (that is the OpenCode stream event, not the Notification)

**Transport**:
The selected channel that carries a Notification from the plugin to the user's device; exactly one is active per instance.
_Avoid_: push, channel, provider

**Adapter**:
A Transport's implementation inside the plugin behind the common publish interface.
_Avoid_: client (that name lives inside an Adapter), provider

**Web Push**:
The W3C Push API (push subscription + VAPID) as a selectable Transport reaching browsers directly, with end-to-end payload encryption.
_Avoid_: ntfy, push notification (that is just a Notification)

**Subscription**:
A browser-side Web Push registration that identifies one device as a delivery target.
_Avoid_: endpoint (that is only the URL part of a Subscription)

**Bootstrap Service**:
The small proxy-reachable register/deregister page where a device creates or removes its Subscription.
_Avoid_: signup page, admin UI

**Subscription Store**:
The file the Bootstrap Service writes and the plugin re-reads at publish time, so registrations take effect without restarting opencode.
_Avoid_: config (that is the validated startup configuration)
