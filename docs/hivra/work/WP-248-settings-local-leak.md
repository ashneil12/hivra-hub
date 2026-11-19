# WP-248: Keep Claude Code's saved approvals (and the passwords in them) out of commits

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | S | WP-200, WP-227 | no (security) |

## Goal

`.claude/settings.local.json`, where Claude Code saves "don't ask again" commands with any password typed in them
(latent.tokyo, 8 Nov 2026), can never leave Ash's machine through Hivra, including from a fresh worktree.

## What already holds (checked 11 Nov)

- Push, land and self-build already refuse the file: `commit_guard.rs` `refuse_paths` and `gate_repo`, the crew
  `pre-push-guard`, `refuse_land_names`, the `--no-verify` and `core.hooksPath` holds in `credentialGuard.ts`, and
  the app's own stage and commit.
- `scripts/setup-worktree.mjs` neither links nor copies it. Hivra's own approval cards never write it.
- hivra-hub's `.gitignore` now ignores it (shipped with the Wave O run-loop PR).

## Gaps (research: `/mnt/project-files/hivra-research/reports/nov11-boxes-safety.md`)

1. A crew's local `git commit` can still commit it. Crews get only `prepare-commit-msg` and `pre-push`
   (`attribution/hooks.rs`). This matters on a machine without Claude Code's global exclude: a temporary HOME, a
   fresh Mac or a Cloud box.
2. A repo that already tracks the file is exempt from the path refusal (`tracked_at_head`, `commit_guard.rs`), and
   only its contents are scanned.
3. `secretPatterns.json` misses command-line passwords: `PGPASSWORD=...`, `mysql -p...`, `sshpass -p`,
   `curl -u user:pass` and `redis-cli -a`.
4. The `.worktreeinclude` copier (`worktree_include.rs`) has no deny for agent files, so a project could copy the
   file into new worktrees.

## Build

1. Add a crew `pre-commit` hook that runs the same path and secret check as `pre-push-guard`, in the same shape.
2. Refuse the path even when it is tracked, unless Ash allows it per repo in Settings.
3. Add the five command-password patterns, with tests using the article's command shapes, to the one shared list.
4. Make `worktree_include.rs` deny `.claude/settings.local.json` and the other agent settings files.
5. Have `hub:doctor` warn when a known project's `.gitignore` doesn't ignore the file.

## Done when

- [ ] Tests for each gap. Full security review.
