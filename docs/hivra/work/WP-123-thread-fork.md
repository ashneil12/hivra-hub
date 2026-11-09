# WP-123: Fork a chat from a message and keep the original

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | none (WP-110 may still be in flight; reuse its worktree helper, do not wait on it) | yes |


## Goal

From a message in a chat, the person can fork: a new chat starts with the history up to that message, the original is untouched, and they can choose to give the fork its own worktree.

## Why

T3 shipped fork in [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) after [issue #1404](https://github.com/pingdotgg/t3code/issues/1404) (28 +1, now closed). It is a small, obvious control. Hivra has no fork-thread path on `origin/main`.

## Read first

- Hivra: chat creation, worktree helpers (`src-tauri/src/worktree_pool.rs`), message list types, any existing 'continue in a new chat' action.
- T3 behaviour (ideas only): [v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) 'Fork any thread'; [thread-sidebar.md](https://github.com/pingdotgg/t3code/blob/e85e0094dd4617a1eada1ad7961f2132a79e67b2/docs/user/thread-sidebar.md).

## Build

1. A 'Fork from here' action on a user or assistant message. It creates a new chat in the same project with a copy of messages up to that point (ids are new; do not share mutable rows with the original). The original is unchanged. Tests for the copy, including attachments metadata, and that later messages in the original do not appear in the fork.
2. Optional: start the fork in a new worktree, using the existing worktree creation and its refusals (dirty tree, non-git, and so on). If WP-110's setting exists, honour it as a default, but always let the person choose on the fork confirm. Tests with the worktree port stubbed.
3. Palette command and a browser spec on Chromium and WebKit.

## Done when

- [ ] Fork copies history up to the chosen message and leaves the original alone.
- [ ] The worktree option reuses existing refusals.
- [ ] Palette command and browser spec exist.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. If any T3 source file is translated, stop unless this brief asked for it; then add the file header, a NOTICE entry with the exact copyright line from T3's LICENSE, a credits.json component, the README inspirations list, and a SOURCES.md row with the commit and file. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
