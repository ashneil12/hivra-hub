# WP-XX: Closed agents and idle runtime reclaim

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | M | 11 | no |

## Goal

A chat that has gone quiet gives back its provider process after an hour, keeps its identity, timeline and saved provider session, and comes back under the same id on the next message.

## Why

Hivra keeps a chat's provider process alive after its turn ends, and a chat whose tab closed while it was still running stays parked and running. Nothing in the harness or session store reclaims an idle process today, so a Mac or a remote box with many chats or Monos holds one CLI process per chat for as long as the app runs.

Paseo (Apache-2.0, getpaseo/paseo, `docs/agent-lifecycle.md`) has the shape worth porting: a `closed` state that releases the process but keeps the record, a one-hour idle collector, a daemon baseline plus a provider veto before anything is closed, and a dead runtime reported as a turn error. WP-11 already supplies the clocks and the classifier. T3 Code's restart-safe resume and WP-11 cover recovery after a crash. This package covers the quiet, healthy case.

## What to take (ideas only, written from the design)

- A closed chat: no live provider process, but identity, timeline, workspace, labels, title, usage, attention and parent kept. The Inbox and the tab list show it as closed.
- One load path. Opening a closed chat or sending it a message resumes the saved provider session under the same chat id. Provider history is not written again when the timeline already has it.
- Idle collection. A chat whose runtime has been idle for an hour is closed, checked once a minute. A host setting turns it off.
- A baseline veto the daemon always applies: a running turn, an open approval or question, a queued delivery, a lifecycle operation in progress, or a working child (Monos or subagents) keeps the runtime. A provider can add a stricter check. A false, error or timeout answer keeps the runtime. Nothing overrides a veto.
- A runtime that exits while idle is reported as a turn failure, so the chat lands in error with a timeline note instead of looking healthy with its background work gone.
- Reload releases the old runtime before it resumes the saved session, because an idle provider can still hold an exclusive writer. A failed close keeps ownership and blocks the replacement. A failed reopen leaves the chat closed and retryable, and does not block other chats.
- The resume prompt, `Continue from where you left off.`, becomes a setting with the same default.

## Don't

- No new mode, second inbox or second orchestrator. Closed chats stay in the lists that exist.
- No model call and no token spend in the collector (a test asserts it).
- Don't close a runtime the provider says is still working, however quiet it looks.
- `src/app/App.tsx`, `src-tauri/src/lib.rs` and `src/features/settings/ui/SettingsView.tsx` stay hook-only.
- Don't copy Paseo code or docs text. Credit it in SOURCES and credits.json.

## Owned paths

- `src/features/sessions/model/` (closed state, load path, idle clock inputs)
- `src-tauri/src/harness.rs` and `src-tauri/src/session_store.rs` (collector and runtime release, via a hook)
- `src/features/inbox/` (closed rows and the "send brings it back" copy)

## Extends

WP-11 (watcher clocks, classifier, restart is a non-event) and the restart-safe resume credited to T3 Code. If Ash prefers, this folds into WP-11 as an addendum; the closed state and collector are the parts that would need a new section. The idle-chat hibernation package (WP-XX, idle chat hibernation) covers the same ground and should be merged with this one if both are kept.

## Done when

- [ ] Tests: one hour idle closes; a running turn, an open approval, a pending delivery and a working child each block closing; a provider veto of `false` keeps the runtime.
- [ ] Test: a closed chat reopens under the same id with its timeline intact; a failed reopen leaves it closed and retryable and does not block another chat.
- [ ] Test: a runtime that dies while idle lands in error with a timeline entry.
- [ ] Browser spec: a closed chat shows as closed, and sending it a message brings it back.
- [ ] `hub:verify-live` passes with the collector on (it kills the app between phases).
- [ ] `npm run check` passes.
- [ ] Paseo is credited in SOURCES.md, credits.json and the PR (ideas only).
