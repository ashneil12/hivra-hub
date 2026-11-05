# Room posts: the ack and the answer stay two paragraphs

Integration-lead rework on `wp/room-posts`. Not pushed. The PR title is unchanged.

## Cause

Found in the S1 bench evidence. Claude Code writes one assistant record per content block, so this was two separate messages, not two text blocks in one record.

The coordinator stream was: a text record "6 asks in. Starting with the hourly checker, then the rest." (message id `7dfd6355`), then a tool_use record of that same message, then about ten tool-use messages, then a separate message `a0007770` whose text was "Six asks. Here's what's true…", then the result. The session blocks stayed separate (wake, ack, tools, answer). There was no steer and no extra assistant block. The room draft froze at the ack (59 chars). The final room post was "…then the rest.Six asks. Here's what's true…".

`pendingAssistantBoundary` was set on the text record. The next record of the same message was the tool_use, which had no text, and the old assignment cleared the flag. `message.completed` never fired before the answer, so the managed reply joined the two deltas with nothing between them.

## What changed

`8f7a2f12` — Revert "Keep a room post's start-ack and answer as two paragraphs". That commit joined two text blocks inside one record. Claude Code never writes that shape. `git revert f1b85da7` was blocked by the approval prompt, so this commit is the same inverse by hand: the five files match `f1b85da7^`, and the diff is the reverse of that commit (220 deletions, 2 insertions). Do not revert `8f7a2f12`; that would put the dead join back.

`ab542812` — Keep the assistant boundary across a same-message tool record. At the end of `handleAssistant`, a later record may only set `pendingAssistantBoundary`. It never clears it. Only a text snapshot or assistant text already emitted sets it. `message.completed` then fires before the next message.

`753e75db` — Break a managed turn's reply on a blank line. `appendControlEvent` adds `"\n\n"` on `message.completed`, not `"\n"`. `App.tsx` calls it from `applyTurnEvent` and nowhere else. One newline was what glued "rest.Six".

`06d71f01` — Post the ack and the answer when the answer block is still late. Tests only. `useRoomRunner` is unchanged: no wait, no flush.

## The lag does not drop the answer

`onSettled` can run before a hidden chat's flush (every 250 ms), so `postText` may see only the ack. `bare` strips whitespace, and the ack's letters are not the letters of `ack\n\nanswer`, so the comparison fails and the function returns the reply. With the two fixes above that reply is already `ack\n\nanswer`. `postText` was not widened.

When the answer block has landed, `bare` matches and the chat's own copy is what gets posted. `cleanPost` trims, so the test that locks this uses a doubled space inside the reply, which `bare` ignores and `cleanPost` keeps.

## Done when

- A tool record of the same message no longer clears the boundary. `keeps a start-ack and the later answer apart when a tool record of the same message comes between them`: ack text (`7dfd6355`), tool_use of that id, tool_result, answer text (`a0007770`). The prose blocks stay `[ack, answer]`, a `message.completed` sits between the two deltas, and folding deltas with a blank line per completed message contains `then the rest.\n\nSix asks.`.
- The managed reply breaks on a blank line. `puts a blank line between two finished assistant messages` is exactly `` `${ack}\n\n${answer}` `` after trim. `does not join a finished message with a single newline` expects `` `${ack}\n\n` ``.
- A settle that still only has wake, ack and tools, with the reply the adapter now produces, posts both paragraphs. `a late answer block still posts the ack and the answer as two paragraphs` contains `then the rest.\n\nSix asks.`.
- A landed answer keeps the chat's copy. `a landed answer keeps the chat's own copy of the two paragraphs` posts exactly `` `${ack}\n\n${answer}` `` when the reply only differs by a doubled space.

## Commands

- `npx vitest run src/integrations/harness/providers/claude/claudeLive.test.ts src/app/hooks/useRoomRunner.flow.test.ts src/app/model/controlText.test.ts` — 3 files, 58 tests, all passed.
- `npm run check` — vitest: 1167 files passed, 2 skipped; 9484 tests passed, 13 skipped. `tsc --noEmit` exited 0 (the script tests ran only after it). Script tests: 321 pass, 0 fail, 2 skipped. `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` exited 0 (`cargo test` is chained after them). `cargo test`: lib 1687 passed, 0 failed, 2 ignored; mobile link 32 passed, 0 failed; the other binaries 0 failed. The captured log ends as the doc-test banners are printed. `cargo test --doc --workspace` after that: 0 tests, 2 suites, no failure.

## Not checked

- A live Claude turn and the native window. Not launched. The provider test feeds the bench's record order; it does not run Claude Code.
- `git revert` itself. The approval prompt refused it. `8f7a2f12` is the inverse, checked with `git diff f1b85da7^` empty on the five reverted paths.
- The daily app. Not launched, not shipped.

## Mac-only, for Ash

- In a dev copy, run a room turn that acks, calls a tool, then answers. The room post should be two paragraphs (`then the rest.` then a blank line then `Six asks.`), including when the answer block lands after the turn has already settled.
