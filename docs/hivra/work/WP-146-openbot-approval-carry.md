# WP-146: OpenBot approval gate, never carry past an unapproved action

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Upgrade (source watch 9 Nov) | S | WP-14 / WP-101 safer approvals (do not edit those worktrees; land on origin/main) | yes |

## Goal

When a tool call is waiting for approval, the conversation must not continue as if it were allowed. Match OpenBot's 9 Nov fix: stop (or clearly park) rather than carrying the turn on past an unapproved action.

## Why

Hivra took OpenBot's approval-gate semantics. Source watch digest 2026-11-09 flagged `644d07d` "Never carry a conversation on past an unapproved action". Nearby OpenBot commits on Activity wording for waiting actions are display ideas only.

## Read first

- OpenBot (MIT): commit `644d07d` and surrounding approval-gate tests.
- Hivra `origin/main`: approval / permission wait paths. Do not weaken fail-closed behaviour.

## Build

1. Docs: copy this file to `docs/hivra/work/WP-146-openbot-approval-carry.md`. Note the OpenBot fix on the existing OpenBot SOURCES / credits line.
2. Find any path where a turn continues, auto-answers, or marks success while an approval is still open. Fix so the turn stays waiting; UI says waiting for approval in plain words.
3. Tests: an open approval leaves the session waiting; a denial is an answer, so the turn goes on without that call; approving then continuing works. Fail closed if the approval record is missing.
4. Out of scope: vault (WP-92), phone approve (mobile wave), browser-action cards.

## Done when

- [ ] Pending approval blocks carry-on; tests pin it.
- [ ] Credits/SOURCES touched only as needed.
- [ ] No new network, keychain, or phone surface.
