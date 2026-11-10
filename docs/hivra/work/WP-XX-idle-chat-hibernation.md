# WP-XX: Idle chats hibernate only when it is safe

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Unassigned (candidate after WP-164) | M | 11, 146 | no |

## Goal

A chat whose turn has settled, and that nobody is looking at, can stop its agent process to free resources. The next message or an opened view brings the same conversation back through the agent's own resume. A chat that is working, waiting on the person, or holding a permission card is never stopped.

## Why

Orchestrator.inc (Apache-2.0) keeps a durable hibernation fact and a boundary table. It never hibernates a session that is provisioning, busy, waiting for input, blocked on approval, or idle after a turn with no confirmed outcome. It hibernates only after a settled idle turn with no view open, and only when the native conversation can resume. Hivra has no equivalent: the word does not appear in the app or the Rust side. Ash runs many chats at once, so this matters once a few are idle.

Open question for the brief: this study did not trace whether an idle Hivra chat keeps a live CLI process. The first build step settles that. If no idle chat holds a process, this package is not needed.

## What to take

- Hibernation is a process boundary, not a display status. The board keeps using activity and PR facts.
- The boundary table, turned into tests row by row.
- A sweep every 30 seconds after a turn settles, plus an immediate check when the chat view closes.
- A failed wake is shown in the chat and retried only by a person's action or the next message. Never in a loop.
- Off by default, behind a setting.

## Read first

- `src/features/sessions/model/session.ts`: `sessionNeedsInput` and `hasPendingApproval`, the read-time checks this must respect.
- `src/features/sessions/model/approvalWait.ts`: the held-card path.
- `src/features/monos/model/workerStall.ts` and WP-11: the stall classifier and the wake queue, which count as pending work.
- WP-161: what already scales under machine load, so this does not duplicate it.
- Orchestrator.inc `docs/architecture.md`, "Chat hibernation boundary" (ideas only).

## Build

1. Record, in the brief, whether an idle chat keeps a live CLI process, and which CLIs resume a native conversation by id. If none keeps a process, stop here.
2. One function decides hibernate or keep, from the boundary table. Each row is a test.
3. Hibernate on a settled idle turn with no open view. Opening the view, sending a message, or a wake from the queue resumes it in the background.
4. Write the boundary to durable state, so a restart reads it as a planned stop and not a crash. A restart does not wake chats on its own.

## Don't

- No new status, lane or badge for "hibernated" on the board.
- Never stop a chat that a first mate is waiting on, or one that has a queued wake.
- No Orchestrator.inc code or prompt text. Port the rules.
- `App.tsx`, `src-tauri/src/lib.rs` and `SettingsView.tsx` stay hook-only.

## Owned paths

- `src-tauri/src/lib.rs` (hook only, as PLAN says)
- `src/features/monos/model/workerStall.ts`
- `src/features/sessions/model/approvalWait.ts`
- `src/features/sessions/model/session.ts`

## Done when

- [ ] Tests for each row of the boundary table.
- [ ] A chat holding a permission card or a pending question is never stopped (tested).
- [ ] A restart with stopped chats wakes none of them until asked (tested).
- [ ] Live check on a dev copy: a settled chat with no view releases its process, and its next message resumes the same conversation.
- [ ] `npm run check` passes.

## Licence

Ideas from Orchestrator.inc (https://github.com/OrchestratorInc/agent-orchestrator), Apache-2.0. No code, prompt or docs text is copied. The LICENSE file carries no copyright line. The source is listed in SOURCES.md and in the inspirations list of credits.json.
