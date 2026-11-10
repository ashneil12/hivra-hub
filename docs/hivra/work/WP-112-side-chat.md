# WP-112: A side chat that borrows the main chat's context without derailing it

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | none | yes |

## Goal

From an open chat, the person can ask a quick side question that already knows what the main chat has been doing. The main chat is not sent that question, is not compacted because of it, and does not change files because of it. A useful answer can be brought back into the main chat when the person asks. Side chats stay off the chat list.

## Why

Ash asked Hermes for what people love about T3 Code. T3's second most wanted missing feature (103 upvotes, discussion 7311) is a side chat that shares the main thread's context without derailing it or triggering compaction. Hivra already has `/btw` and `BtwSheet`: a read-only side conversation on a completed agent response, which does not change the main thread (CHANGELOG, `#353`; `src/features/sessions/model/btw.ts`, `ui/BtwSheet.tsx`). The older T3 note that said this was not built is out of date.

This package closes the remaining gaps, it does not rebuild BTW:

- A side question should work from the main chat's current knowledge, not only from one finished turn if the existing sheet already has a better hook.
- Asking it must not compact or otherwise mutate the parent chat.
- The person can bring a useful side answer back into the parent as a normal message they can edit before send.
- Side chats stay out of the chat list.
- If a gap above is already true, say so in PR.md with the file evidence and skip that item.

T3 Code is MIT, "Copyright (c) 2026 T3 Tools Inc." Its side chat (`SideChatPane.tsx`, `ThreadForkService.ts`, `ContextHandoffService.ts`, `docs/user/thread-lineage-and-context-transfer.md` in the local read-only checkout) is an idea to rebuild, not code to copy. Hivra's existing BTW path is the implementation to extend.

## Read first

- Hivra: `src/features/sessions/model/btw.ts` and `btw.test.ts`, `src/features/sessions/ui/BtwSheet.tsx` and `BtwSheet.test.ts`, `Composer.tsx` `/btw` handling, `modeCommands.tsx`, CHANGELOG entries for BTW.
- The parent-safety rule already in `btw.ts` (do not change files, run write actions, steer the parent, or claim the parent was changed). Keep it.
- Local read-only T3 notes (not in this repo): the side chat row of the T3 rip list, love.md section B2, and deepdive.md on fork and side chats.
- Do not copy T3 source. Ideas only.

## Build

1. **Start from BTW.** Read the files above and write a short "what already works" list in PR.md before changing anything.
2. **Open a side question from the open chat** with `/btw` or `/side` (alias) and a control on the chat. It starts with a compact recap of the parent (recent turns and, if useful, the current file or diff the parent was on), in the same project folder. Reuse the existing isolated text runner and `BTW_HARNESSES`. If a harness cannot run a side question, say so in a plain sentence and do not show a broken control.
3. **Do not derail the parent.** Sending a side question must not append to the parent transcript, must not start a parent turn, must not compact the parent, and must not change files. Keep the existing read-only instruction. Tests for each of those.
4. **Bring back.** A "Add to the main chat" action copies the side answer (or the person's selection) into the parent composer as a draft they can edit and send. It does not send itself. Tests for the draft and that the parent is otherwise unchanged.
5. **Stay off the chat list.** Side chats are not rows in the session sidebar. They remain attached to the parent, as today's BTW threads are.
6. Browser spec on Chromium and WebKit: open a side question, see the recap, confirm the parent transcript is unchanged, bring an answer back into the composer.

## Copy with credit

Ideas from T3 Code need no credit. If you translate any T3 file (you should not need to), add a credits.json and NOTICE entry with "Copyright (c) 2026 T3 Tools Inc." and the file, licence and commit; otherwise leave credits alone.

## Done when

- [ ] PR.md lists what BTW already did and what this package added or skipped, with file evidence.
- [ ] A side question borrows the parent's context, does not appear on the chat list, and does not compact or edit the parent.
- [ ] Bring-back fills the parent composer only, and the person still has to send it.
- [ ] Tests and the browser spec above are green on Chromium and WebKit.
- [ ] No em dashes or en dashes in any text a person sees.
