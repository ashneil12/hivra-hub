# WP-138: Honour a .worktreeinclude file when creating worktrees

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | none | yes |

## Goal

When Hivra creates a git worktree for a chat or task, it honours a `.worktreeinclude` file in the project so env files, gitignored config, and other named paths can be copied into the new worktree. If a copy fails, or a CLI that makes its own worktree would not have those files, the UI says so rather than failing quietly.

## Why

T3 still does not have this. [Discussion #6905](https://github.com/pingdotgg/t3code/discussions/6905) is open with 26 +1 (9 Nov REST sample). Shipping it is a small beat. It also makes Hivra's worktree-per-chat story (WP-110) more usable on real projects that need a local `.env`. This is not WP-118 (sparse checkout): that package is an optional sparse checkout tool. This package only copies named files into a normal worktree.

## Read first

- Hivra: `src-tauri/src/worktrees.rs`, `src-tauri/src/worktree_include.rs`, the worktree pool, and the chat header in `NewChatWorktreeBanner`.
- T3: [discussion #6905](https://github.com/pingdotgg/t3code/discussions/6905) for the requested shape. The worktree user doc is `docs/user/source-control.md` at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`. Do not wait on T3.
- WP-118 is a separate sparse-checkout package. Do not start a second sparse-checkout path here.

## File format

`.worktreeinclude` sits at the root of the checkout the worktree is created from. One path per line, relative to that root, using `/` between parts. A line that is empty or whose first non-space character is `#` is a comment. `\r\n` line endings are fine.

Hivra reads the file on disk, including when it is untracked or newer than the last commit. A missing file, or a file that is only comments, changes nothing.

A path is refused, and not copied, when it leaves the checkout: an absolute path, a drive letter, a `..` part, an empty part, or a link. `./` is allowed and means the checkout root. A listed directory copies the regular files inside it, and does not follow links. At most 100 files are copied; the rest are reported, not copied.

Copied files are not staged. A file git already placed in the new worktree is left as it is. File contents are never logged and never shown in the note.

## Build

1. The format above. Tests for allow, deny-escape, and a missing file (today's behaviour).
2. When a worktree is created, copy the allowed files (and only those) into the new worktree. A copy failure does not undo the worktree. Tests with a temp repo.
3. A one-line note in the chat header if includes were copied, and a warning if a copy failed. When the copied files would be missing from a worktree a CLI makes on its own, the note says so.

## Done when

- [x] `.worktreeinclude` is honoured, with escape-path tests.
- [x] Missing file keeps today's behaviour.
- [x] File contents are never logged.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
