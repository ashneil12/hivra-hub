# WP-44: Desktop control plugin

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | S | 31 | yes |

## Goal

An opt-in Desktop control plugin lets workers use desktop apps through accessibility trees, off by default and
with consent per app.

## Why

Ash's desktop control (vision item 8). vercel-labs/agent-desktop (Apache-2.0) is agent-agnostic, headless-first and
safety-minded, and very new, so it is offered, not default.

## Read first

- agent-desktop: README, `CONCEPTS.md` (interaction policy, delivery and retry, secure-field redaction), its
  embedded skill.
- WP-30 and WP-31.

## Build

1. A Desktop control plugin entry: the pinned binary and its skill, so any worker CLI with a shell can use it.
2. Consent: off until the person turns it on; then an allow list of apps per project, asked the first time an
   agent touches a new app. Headless by default; visible control only when the person allows it.
3. A spike, reported in the PR: can agent-desktop read Hivra's own window (Tauri's web view) well enough for agents
   to test Hivra itself? Note what labelling the UI would need.

## Done when

- [ ] Tests: install, consent prompt on a new app, refusal when off (stubbed binary).
- [ ] The spike's findings are in the PR; `npm run check` passes.
