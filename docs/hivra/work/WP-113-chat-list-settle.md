# WP-113: Optional settle, snooze and re-sort for the chat list

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | none | yes |

## Goal

A setting, off by default, lets the chat list work like a quiet inbox: finished chats can be settled (hidden, not deleted), a chat can be snoozed until a time, and with the setting on the list may re-sort so a chat that needs the person comes back to the top. With the setting off, today's list behaviour is unchanged. The Being built list is not touched: its rows still never re-sort.

## Why

Ash, 6 Nov 13:50, on the T3 sidebar question: "it can be optional if the chat list settles, snooze, and resorts." T3 users like this because many parallel threads stay manageable (love reason 11). Hivra's chat list does not settle or snooze chats today (snooze exists only for the setup card and for reminders). Being built has a standing rule that rows never re-sort (`HANDOFF.md`). That rule stays. This setting is only for the session chat list.

T3's settle, snooze, auto-settle on merge, early wake and undo (`ThreadSettlementService.ts`, `Sidebar.snooze.ts`, `showThreadUndoNotice.ts`, `docs/user/thread-sidebar.md`) are an idea to rebuild, not code to copy. T3 Code is MIT, "Copyright (c) 2026 T3 Tools Inc."

## Read first

- Hivra: how the session sidebar lists and sorts chats (search `src/features/sessions` and the sidebar/shell for the chat list, archive, pin). `HANDOFF.md` on Being built. Reminder snooze in `ReminderNotices.tsx` is a different feature; do not reuse it as chat-list snooze without reading it first.
- Local read-only T3 notes: `~/Worktrees/hivra-research/t3code/T3-RIP-LIST.md` (settle/snooze row and decision 2), `t3code/love.md` section 11, `t3code/deepdive.md` "Settle, snooze, pin, archive, undo".
- Do not copy T3 source. Ideas only.

## Build

1. **A setting, off by default.** Something like `chatListInbox` (name it in the existing settings model), stored with the other app settings, validated on read, missing or old settings read as off. Settings copy in plain words: the chat list can settle finished chats, snooze a chat until a time, and re-sort so a chat that needs you comes back to the top. Off keeps today's list. Tests for the model and the migration.
2. **Settle.** With the setting on, a chat can be settled: it leaves the active list, is not deleted, and lives on a Settled shelf the person can open. Unsettle brings it back. Settling does not delete files, worktrees or transcripts. Do not auto-close a terminal that is still running a command.
3. **Snooze.** With the setting on, a chat can be hidden until a chosen time. It wakes early if it needs approval, asks a question, fails, or the person sends a message. Unsnooze is always available. Every way in has a way out.
4. **Re-sort only when the setting is on.** Active chats may move so that a chat which just needed the person, or just got a reply, comes back to the top. With the setting off, the current order does not change. Being built is never re-sorted by this package.
5. **Auto-settle on merge, optional and behind the same setting.** If a chat's PR merges and the person has not sent a message since, the chat can settle itself. An old merged PR must not settle work the person resumed after the merge. If hooking this up is more than a small change to the existing PR-watch path, skip auto-settle and say why in PR.md.
6. **Undo.** Settle, unsettle, snooze and unsnooze can be undone from one short notice. Screen-reader text too.
7. Browser spec on Chromium and WebKit: setting off leaves the list as it is; setting on, settle a chat, find it on the shelf, undo, snooze and unsnooze.

## Copy with credit

Ideas from T3 Code need no credit. Do not translate T3 source for this package.

## Done when

- [ ] The setting is off by default and old settings stay off.
- [ ] With it off, tests show the chat list order and rows are unchanged.
- [ ] With it on, settle, snooze (with early wake), unsnooze, unsettle and undo work, and Being built still does not re-sort.
- [ ] Browser specs above are green on Chromium and WebKit.
- [ ] No em dashes or en dashes in any text a person sees.
