# Spec: agent.notify forwarding + idle enrichment (port of MR #1 values)

## Problem Statement

An agent that says "notify me when X" has no channel: opencode has no built-in
notify tool, and the plugin only reacts to lifecycle events. Idle pushes say
"session sess_xxx is idle" — opaque and without substance.

## Solution

1. **agent.notify (Notification Kind 5)**: the `execute.before` hook filters
   on a configurable list of notify tool names (default
   `["opencode_notify", "openchamber_notify"]`, the tools this user already
   runs). A matching call publishes its title/body as a push (tag `bell`),
   default on, no suppression, never deduplicated.
2. **Idle enrichment** (`enrichIdleMessages`, default on): idle drafts carry
   the human session title (cached by the session registry from lookups) and
   the last assistant output (via `ctx.session.context`, raced against a 2 s
   deadline); any failure falls back to the generic message. The README
   "What data is transmitted" section documents both fields.

## Decisions (from the grilling round)

- Tool source: configurable names only, no plugin-defined tool (variant A).
- Enrichment default: **on** (user decision), disclosed in the README.
- Enrichment deadline: **2 s race**; timeout, throw or missing context →
  generic message.
- Strict config validation stays (unknown keys rejected, secret-safe errors).
- Folds into the unpublished 0.3.0 CHANGELOG.

## Out of Scope

- Defining a plugin-owned notify tool (variant B) — revisit if the tools do
  not exist in a target environment.
- Feed-back PR to the original project (review comments for maboch MR #1) —
  manual step by the owner.
