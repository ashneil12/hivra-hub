# WP-135: Fan one prompt out to several models and compare the winners

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | M | none (reuse worktree helpers; first mate may call this later but is not required) | yes |


## Goal

From the composer, the person can send the same prompt to two or more models or CLIs at once. Each run gets its own worktree (or a documented exception). A compare view shows the results side by side. The person picks a winner; the others can be discarded with their worktrees, using existing janitor rules.

## Why

Orca makes this a headline ([onorca.dev](https://www.onorca.dev/): fan a prompt across agents, merge the winner). T3 has a quieter version: Shift-click several models on a new thread ([thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/thread-sidebar.md)). Hivra's crew can run parallel workers from a brief, but there is no 'same prompt, N models, pick a winner' flow. This is a beat of both T3 and a hook against Orca.

## Read first

- Hivra: composer send path, worktree pool, first-mate crew (do not overload it; this is a peer-compare, not a lead-and-workers brief).
- T3: [thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/thread-sidebar.md) Shift-click. Orca: [onorca.dev](https://www.onorca.dev/). Ideas only.

## Build

1. A fan-out model: a list of (provider, model) pairs, a shared prompt, a parent 'compare' record that points at N child chats. Caps: start with a low documented maximum (for example 4) so this cannot start a dozen paid sessions by accident. Tests for the cap and for worktree assignment.
2. Composer UI to pick several models and send. Confirm the cap and that each run may burn a paid turn. Browser spec.
3. A compare view: each child's status, a short diff or last message, and 'pick this one' / 'discard'. Picking can copy the winning worktree's branch into a place the person already uses (reuse an existing apply or checkout helper if one exists; otherwise leave the winning worktree as the one that stays, and say so). Tests for pick and discard, including janitor cleanup of losers.
4. Do not auto-merge code from several winners. The person picks one.

## Done when

- [ ] One prompt can start several capped child chats, each in its own worktree when git allows.
- [ ] Compare, pick, and discard work, with tests.
- [ ] Nothing is auto-merged.
- [ ] The confirm mentions paid turns.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
