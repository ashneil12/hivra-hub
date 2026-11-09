# WP-115: Idle compact, and a plain sentence when an agent cannot redirect

Two polish items. No T3 source copied. The package note leaves the local research paths out.

## What changed

Idle compaction now starts before the prompt cache dies, instead of only on the next send after it has already died.

- A large Claude chat (at least 100K tokens; exactly 100,000 still qualifies) becomes due once it has been idle for longer than `ttl - 2 minutes`.
- When the stored TTL is under two minutes, the lead is half the TTL. Proactive compact is not skipped. A TTL of exactly two minutes uses the full two-minute lead, so it is due as soon as the chat has been idle at all.
- TTLs are the ones already stored: about one hour when the usage reported a 1 hour cache, about five minutes for a 5 minute cache. Nothing new is invented. A missing TTL keeps the last known one.
- While the app is open, a due idle Claude chat is compacted in the background with the same quiet `/compact` path. It does not mark the chat busy, and it does not send a message. One line appears in the chat: "Compacted this idle chat so the next message does not rebuild the whole prompt cache."
- A chat that is mid-turn is left alone. A send during the early window does not compact. Sending after the cache has already expired (`idle` longer than the TTL, not equal to it) still compacts first, with the existing status line.
- The "Compact idle chats first" setting still turns this off, including the background look. The 100K floor is unchanged.
- Two windows do not both compact the same chat. A claim is written and read back, then confirmed after a short wait. Remembering the cache drops the claim. A failed compact releases it so a later look can retry. A dead conversation forgets the cache instead of retrying forever.

Plain sentences, for the two controls that offered a redirect some agents cannot do.

- Grok Build, fx, Devin and Antigravity are the live adapters with `canSteer: false`. Claude, Codex, Cursor, OpenCode, Pi, omp and Hermes can steer. An adapter that is not registered is not treated as a refusal, so a fixture that has not registered Claude still shows Steer.
- While one of those four is busy, Steer on a queued message is hidden and one sentence is shown: "Grok Build can't redirect a running turn. Stop it, then send." (the title changes with the agent). Send becomes Stop, and the draft stays, when follow-ups are set to steer. The same sentence sits by the box only when nothing is queued, so it is never shown twice.
- If follow-ups are set to queue, Send still queues. The sentence stays on the Steer slot only, and only when a message is waiting there.
- Steer while the chat is idle still sends, for every agent.
- If a stale view still submits a redirect, the app keeps the message and says the same sentence. A harness that is not live, rather than one that refuses, gets "fx can't take a follow-up mid-turn. Wait for this turn to finish, or stop it first." A Mono that cannot steer still queues, as before.

## Search for "can't do that" places

Two real lying controls. The rest were already hidden or were not a missing capability of the current agent. No extra strings were added for them.

1. Queue Steer. Wired. The button was shown whenever a steer handler was passed, including for an agent that cannot steer. The click used to drop the message.
2. Send while a turn is running, when follow-up behavior is steer (the default). Wired. The button stayed Send and the same drop happened.
3. Edit last turn. Already hidden. Only Pi, omp, Codex and OpenCode support it, and the button is not passed through otherwise.
4. Compact. Already hidden. The meter only offers it when that agent has a compact path (not Cursor, fx, Hermes or Antigravity).
5. Attachments. Already honest. fx cannot attach, and the upload control is already disabled with "fx does not support attachments".
6. Fork. No fork button in the session UI.
7. Handoff and Second opinion. They start another agent. They are not a missing action of the current one.
8. Queue edit and delete. Local, for every agent.
9. Settings, Follow-up behavior. A global Queue or Steer choice, not a per-chat button that lies.
10. The orchestration steer call. An agent API error ("cannot take guidance mid-turn"), not a button a person presses. Left as it was. It has no dash.

Codex can steer, so the example sentence is not used for Codex.

## Done when

1. A large idle Claude chat is compacted about two minutes before cache expiry, with a visible notice, and mid-turn chats are left alone.
   Evidence: `idleCompactionDue` is due one minute before a one-hour TTL at or above 100K (`expired: false`) and not due at exactly 58 minutes. `compactDueIdleClaude` sends `/compact` at 59 minutes and emits the notice, sends nothing at 58 minutes, and sends nothing while a turn is open. The notice has no em dash or en dash. `idleCompactWatch` skips a busy chat, a non-Claude chat, and a removed worktree.

2. The previous on-send fallback still runs if the cache has already expired.
   Evidence: a send at 61 minutes still compacts with the "Idle 1 h 1 min, past the 1 h prompt cache" status. A send at 59 minutes does not. A send at 30 minutes does not. Exactly at the TTL is due for the background compact and is not the on-send fallback (`expired` is `idle` strictly past the TTL).

3. The existing setting still turns the feature off.
   Evidence: `monocode.idleCompact` set to `"false"` keeps both the on-send path and the background look from compacting, including a chat that would otherwise be due.

4. At least one real "can't do that" sentence is wired to a real button, with tests.
   Evidence: two places, above. `MessageQueue` hides Steer and shows one `role="note"` when given the sentence. `redirectNotePlace` puts it on the queue when a message is waiting, beside the box only when Send would redirect, and nowhere when follow-ups already queue and nothing is waiting. The browser spec, on Chromium and WebKit, shows the Grok sentence with no Steer and a Stop button, and a Claude queue that still has Steer and Send, plus the compact notice in the transcript.

5. No em dashes or en dashes in any text a person sees.
   Evidence: the new sentences and the compact notice are asserted free of both dash characters. The old follow-up status, which contained an em dash, now uses the plain sentences. No repo-wide dash cleanup.

## Commands

Idle compact unit tests, after the type fix:

`npx vitest run src/features/sessions/model/contextCeiling.test.ts src/integrations/harness/providers/claude/claudePromptCache.test.ts src/integrations/harness/providers/claude/idleCompactWatch.test.ts src/integrations/harness/providers/claude/claudeLongChats.test.ts`

`PASS (42) FAIL (0)`

`npx tsc --noEmit --pretty false`

`TypeScript: No errors found`

Capability sentences, after the wiring:

`npx vitest run src/features/sessions/model/cantDo.test.ts src/integrations/harness/core/registrySteer.test.ts src/features/sessions/ui/MessageQueue.test.ts`

`PASS (12) FAIL (0)`

`npx tsc --noEmit --pretty false`

`TypeScript: No errors found`

Browser, Chromium and WebKit:

`npx playwright test tests/browser/wp115-cant.spec.ts --project=chromium --project=webkit`

`PASS (2) FAIL (0)` in about 12s.

Full check:

`npm run check`

- Vitest: 1258 files passed, 2 skipped. 10251 tests passed, 13 skipped. 111.50s.
- Script tests: 417 tests, 415 passed, 0 failed, 2 skipped.
- `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test`: lib 2116 passed, 0 failed, 4 ignored. The other crate tests in that run passed (32, and empty doc-test targets).

The capability tests failed first, before the production code, on the missing module, the missing `harnessCannotSteer`, and the missing Steer sentence. They were not weakened.

## Not checked

- A real Claude chat left idle in the app until about two minutes before its cache expires. The timing and the `/compact` call are covered with the fake Claude. The notice text is covered in the browser transcript. The live process, the real cache TTL, and a parked session waking up for the compact were not.
- A real Grok, fx, Devin or Antigravity turn. The browser page registers stub adapters with `canSteer: false` for Grok and a steerable stub for Claude.
- Whether other browser specs fail. The new spec passed. `npm run check` does not run Playwright. Pre-existing browser failures on main were not re-run.

## For Ash, on a Mac

- `npm run hub:dev` in this worktree. Leave a Claude chat above 100K tokens idle until shortly before its prompt cache expires. The notice should appear without sending. A chat that is mid-turn should be left alone. Turn the setting off and the look should stop.
- Open a busy Grok, fx, Devin or Antigravity chat. Steer on a queued message should be gone, with one sentence in its place. With follow-ups set to steer, typing should show Stop, not Send. With follow-ups set to queue, Send should still queue. A busy Claude chat should still show Steer.
