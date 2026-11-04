# WP-82: Ready worktrees for every crew

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| F | M | none | yes |

## Goal

A crew starts in seconds in a worktree that already has its installs and build cache, instead of a fresh checkout
that reinstalls packages and rebuilds Rust from nothing. When the crew is done, its worktree goes back to a pool,
clean and with no processes left running in it, ready for the next one.

## Why

Ash, 4 Nov: shared Kun Chen's [treehouse](https://github.com/kunchenguid/treehouse) (MIT, Go, macOS, Linux and
Windows). On 4 Nov every Hivra package worktree rebuilt 7 to 10 GB of Rust from scratch, the slowest part of each
build. treehouse keeps a pool of worktrees per repo and is careful: a dirty, leased or unverifiable worktree is never
handed out, lingering processes are stopped and checked on return, and unknown ownership after a crash is quarantined.
It has a machine interface built for callers like Hivra (`get --lease --json`), so Hivra **uses it as a pinned tool**.

## Read first

- treehouse `README.md` (all of it: leases, return, prune, state recovery, `.worktreeinclude`, `worktree_path`,
  `base_branch`, `max_trees`), `VISION.md`, `treehouse.toml.example`.
- Hivra: `src-tauri/src/worktrees.rs` (`git_orchestration_worktree_create` and `..._remove`),
  `src-tauri/src/worktree_janitor.rs`, `scripts/setup-worktree.mjs`, CLAUDE.md "Project file and worktree clean-up"
  and "Rust build cache", the crew dispatch path (WP-12), and WP-81's pinned-tool helper (share one).

## Build

1. **A pinned tool**, the same way as WP-81: a release asset for this platform at a pinned version, a SHA-256 check,
   and `<data>/tools/treehouse/<version>/`. Share the download-and-verify code with WP-81. Whichever merges second
   reuses the first one's.
2. **The pool lives where people look.** Root it under `~/Worktrees/pool/` (configurable), so Settings → Worktrees
   lists it. Each slot shows its lease holder (the crew), state (leased, available, dirty, quarantined) and size.
   Clean up never removes a leased slot. It offers `treehouse prune` for idle, landed ones, as a preview first, with
   Ash's tap.
3. **Crews take a slot.** Where a crew's worktree is made today, call
   `treehouse get --lease --json --lease-holder <crew id> -b <branch>`, and record the `lease_id`. When the crew's
   work has landed (merged, or delivered and closed), call `treehouse return <path> --if-lease-id <id>`. A slot that
   won't return (dirty or a process still running) stays leased and shows in Clean up with the reason. It is never
   forced.
4. **Seeding.** Use `.worktreeinclude` for the gitignored files a slot needs (env files). Keep the Setup action for
   anything else, and make it a no-op when the slot's `node_modules` already matches the lockfile.
5. **Limits.** `max_trees` per repo, default 6 and set in project settings. When the pool is full, the crew waits
   in the queue with a plain note, rather than failing.
6. **Fallback.** If the tool can't be fetched or the person turns the pool off, crews get a plain `git worktree` as
   today, and the app says why once.
7. **Interactive worktrees too** (optional, off by default): "New worktree" in the UI can take a slot from the same
   pool.
8. **Dev copies** use a pool root inside the slot's data folder and never the person's `~/Worktrees/pool/`. Tests use
   a temporary HOME, a fixture repo with a local bare `origin`, and the real pinned binary (it only runs git
   locally).

Credit treehouse (MIT) in credits.json. If a later change bundles its binary, add a `NOTICE` entry.

## Done when

- [ ] Tests:
  - a crew gets a leased slot and a second crew gets a different one;
  - return hands the slot back clean, and the next crew reuses it with `node_modules` and `target/` intact;
  - a dirty slot isn't returned and shows its reason;
  - a full pool queues the crew;
  - the fallback works with the tool missing;
  - the checksum is checked;
  - a dev copy never touches the real pool root.
- [ ] Windows: the same tests on the Windows runner.
- [ ] `npm run check` passes. Dev-copy check: two crews in a row on Hivra's own repo, with the second one's
      `cargo check` time in the PR, before and after.
