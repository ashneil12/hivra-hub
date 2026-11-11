# WP-183: The chat doctor finds broken chats and repairs what is safe

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 11 | no |

From PLAN.md, "Ideas from kitze's factory teaser", item 4. Ideas only, nothing credited.

## Goal

The app finds broken chats by itself (a lost transcript, a turn that never ends, a chat that fails on every message),
repairs the ones it can repair safely, and keeps a short list the person can open: what it found, what it did, and
what it left for them.

## What Hivra has

- Harness care (`src/features/monos/model/harnessCare.ts`, `careFaults.ts`): on the stall watcher's half-minute tick
  it sees five kinds (`CareKind`: `database`, `ship`, `pr-watch`, `resume`, `orphan`) and three one-way fixes
  (`CareFix`: `pause-pr-watch`, `continue-chat`, `cancel-orphan`), with backoff, a Bot changes row per fix
  (`src/features/hub/model/botChanges.ts`) and one Needs-you row for what it cannot fix. It runs no model.
- Resume: `src/features/sessions/model/inFlight.ts` (`MAX_AUTO_RESUMES` 3, `resumeStopped`,
  `RESUME_STOPPED_MESSAGE`); a missing Claude transcript ("No conversation found" in `claude.ts`) starts fresh from a
  brief (`handoff.ts`).
- `harnessRepair.ts` `autoRepairable`: never a sign-in, billing or usage refusal, never a question, never something
  the person stopped.
- WP-11's stall classifier (`src/features/monos/model/workerStall.ts`) and `useStallWatch.ts` for delegated workers.
- `monocode healthcheck` (`instance::healthcheck_main`) for the database.

## What to build

1. **Three new kinds in `careFaults.ts`**, pure, from rows the tick already reads:
   - `lost-transcript`: a chat whose saved provider session id no longer resolves (the adapter says so on resume, or
     the Claude transcript file is missing), seen before the person sends to it.
   - `endless-turn`: a chat marked busy with no harness event for 30 minutes, no open question or approval, no
     background work (`hasBackgroundWork`, WP-174's fix) and no WP-11 stall already raised for it.
   - `failing-chat`: the last three turns in a row failed with the same non-account error class.
2. **Fixes, each one-way and listed in `SAFE_FIXES`:**
   - `lost-transcript`: mark the chat so its next message starts fresh from the brief (the existing `handoff.ts`
     path) and add the "recovered" note now, not after a failed send.
   - `endless-turn`: stop the turn through the adapter's normal cancel, keep the transcript, and add a note naming how
     long it was silent. Never for a chat a first mate is waiting on; that goes to the first mate as a wake instead.
   - `failing-chat`: no automatic fix. One note in the chat with the repeated error in plain words.
3. **The list.** Settings > Diagnostics gains "Chat doctor": the last 50 findings with when, which chat (a link),
   what was seen, what was done or "left for you", read from the Bot changes rows care already writes plus a
   `found` row for findings with no fix. Nothing new on Home.
4. A switch, Settings > Diagnostics > "Repair broken chats by itself", on by default for finding and listing; the
   two acting fixes follow it. Off means it lists only.

## Rules

- Never touches the person's words, a question, an approval card or a chat the person stopped.
- No model call and no token spend (a test asserts no harness send).
- Each fix at most once per fault id, with care's existing backoff.
- Dev copies run it on their own data only; it never reaches the daily app's processes.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: new kinds in the Hub's own modules; upstream session code gets no new state.

## Done when

- [ ] Red first, one test per kind: a seeded chat with a missing transcript, a busy chat silent for 31 minutes, and a
      chat with three same-class failures are each not found today; then found once, with the same id each tick.
- [ ] Tests: no `endless-turn` for a chat with an open question, an approval, background work, or a delegation
      owner waiting; no `failing-chat` for auth, billing or usage classes; each fix runs once per id.
- [ ] Test: a `lost-transcript` chat's next message carries the recovered brief and does not fail first.
- [ ] Browser spec `tests/browser/chat-doctor.spec.ts`: the list with a fixed, a listed and a left-for-you row, and
      the switch turning fixes off. Screenshot in the PR.
- [ ] `npm run hub:verify-live` still passes. `npm run check` passes.

## Not in this package

Repairing the database (stays `monocode healthcheck` and care's `database` kind). Rewriting a transcript. A model
that diagnoses chats.
