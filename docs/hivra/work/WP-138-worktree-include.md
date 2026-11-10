# WP-138: Honour a .worktreeinclude file when creating worktrees

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | S | none | yes |

## Goal

When Hivra creates a git worktree for a chat or task, it honours a `.worktreeinclude` file in the project so env files, gitignored config, and other selected gitignored paths can be copied into the new worktree. If a copy fails, the UI says so rather than failing quietly.

## Why

T3 still does not have this. [Discussion #6905](https://github.com/pingdotgg/t3code/discussions/6905) is open with 26 +1 (9 Nov REST sample). Shipping it is a small beat. It also makes Hivra's worktree-per-chat story (WP-110) more usable on real projects that need a local `.env`. Claude Code already honours a `.worktreeinclude` for the worktrees it makes itself, so Hivra matches its format and behaviour: gitignore syntax, and only files git ignores are copied. This is not WP-118 (sparse checkout): that package is an optional sparse checkout tool. This package only copies selected files into a normal worktree.

## Read first

- Hivra: `src-tauri/src/worktrees.rs`, `src-tauri/src/worktree_include.rs`, the worktree pool, and the chat header in `NewChatWorktreeBanner`.
- T3: [discussion #6905](https://github.com/pingdotgg/t3code/discussions/6905) for the requested shape. The worktree user doc is `docs/user/source-control.md` at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`. Do not wait on T3.
- WP-118 is a separate sparse-checkout package. Do not start a second sparse-checkout path here.

## File format

`.worktreeinclude` sits at the top of the repository the worktree is created from, and uses gitignore syntax, as Claude Code's does: patterns, `!` to drop a match, `**`, and `#` comments. `\r\n` line endings are fine. Git does the matching, so escaped characters, negations and directory patterns behave exactly as they do in `.gitignore`.

Only files git ignores are copied. A tracked file is already in the new worktree, and an untracked file that is not ignored is the person's work in progress, so both stay where they are. A pattern that names nothing is not an error.

Git is first asked which untracked files the patterns select, and then which of those the checkout's own ignore rules cover, by name. It is never asked to list every ignored file, so a large ignored tree such as `node_modules` cannot fill the listing and hide a later `server/.env`.

When the project folder is a subfolder of its repository, the file, the listing and the copy all work from the top of the repository, as Claude Code's do, and files land at the same path in the new worktree. A `.worktreeinclude` below the top is not read.

Hivra reads the file on disk, including when it is untracked or newer than the last commit. A missing file, or a file that is only comments, changes nothing.

No pattern can reach outside the checkout: an absolute path, a drive letter or a `..` part names nothing git lists under the root. The copy step itself also refuses a link and any path that resolves outside the worktree. The source is opened without following a link and checked once it is open, so a file swapped for a link between the check and the copy is refused. At most 100 files and 50 MB in all are copied; the rest are named in the warning (up to three names, then a count), not copied.

A copy is created with its source's mode, so a private file is never readable by others while it is written, and a folder made for it takes the source folder's mode. A worktree made for a pull request wake gets none of the files: the code in it is someone else's and could read them.

Copied files are not staged. A file git already placed in the new worktree is left as it is. File contents are never logged and never shown in the note.

## Build

1. The format above. Tests for pattern matching, negation, only-ignored, escape paths, and a missing file (today's behaviour).
2. When a worktree is created, copy the selected gitignored files into the new worktree. On the pool path, copy before the project's setup starts, because setup may need the files. A copy failure does not undo the worktree. Tests with a temp repo.
3. A one-line note in the chat header when files were copied, and a warning if a copy failed. A CLI honours the same file for a worktree it makes itself, so the note only says the files are here.

## Done when

- [x] `.worktreeinclude` is honoured with gitignore syntax, copying only gitignored files, with escape-path tests.
- [x] Missing file keeps today's behaviour.
- [x] File contents are never logged.
- [x] On the pool path the copy runs before setup.
- [x] The note does not claim another CLI's worktree will lack the files.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT, Copyright (c) 2026 T3 Tools Inc. Ideas need no credits.json component. No T3 source is copied. Do not copy T3 Connect, Clerk, telemetry, or the T3 name.
