# WP-118: Optional sparse git checkouts for large repos, using gion

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| M | M | none | yes |

## Status (10 Nov 2026)

Not built. A first attempt (PR #121) was taken back to this note: it called gion commands that the real gion CLI does not have, and turning the switch on broke every new worktree. A rebuild starts from the pinned tree's own README and `--help` output, and its tests run the real pinned binary against a local fixture, not a stand-in that accepts any command.

## Goal

For a large git project, the person can opt in to a sparse checkout for a new worktree or a short-lived agent workspace, so the agent fetches only the paths it needs instead of a full working copy. It is off by default. Ordinary `git` remains the default path. gion is a pinned tool, not a rewrite of Hivra's git layer.

## Why

A find: [baz-scm/gion](https://github.com/baz-scm/gion) (Apache-2.0, 32 stars on 9 Nov, pushed 9 Nov, Go, status: beta, clone commit `e68ecda`). It is a git-protocol client aimed at agents: no full clone up front, a workspace holds only the paths you ask for, and it can still diff, commit and push. That is useful on large repos where Hivra already creates many worktrees (WP-82, WP-110). It is not a replacement for everyday git on ordinary projects.

gion's Apache licence appendix still has the placeholder "Copyright [yyyy] [name of copyright owner]". Do not invent a copyright holder. Read the pinned tree's LICENSE and any NOTICE or source header; use the exact line if one exists, otherwise credit "gion (https://github.com/baz-scm/gion)", Apache-2.0, pin the commit, and say in PR.md that no copyright line was present.

## Read first

- gion README, `AGENTS.md`, docs on workspaces and limitations (https://baz-scm.github.io/gion/limitations/ if fetched, or the in-repo docs), licence.
- Hivra: worktree creation (`src-tauri/src/worktrees.rs`, `worktree_pool.rs`, `worktree_janitor.rs`), WP-110's new-chat worktree setting, project file setup scripts, `src-tauri/src/fs.rs` git helpers, how credentials are already obtained (`gh`, git credential helper). The delivery gate and PR path assume a normal git worktree.
- Pin pattern: WP-81 / `pinned_tool.rs` (checksummed binary, no `curl | sh` at runtime).

## Build

1. **A pinned tool, optional.** Fetch one gion release asset (or a build you can checksum) for this platform, pin version and SHA-256 in the repo, keep it under `<data>/tools/gion/<version>/`. No `curl | sh` in the product, no self-update. Dev copies use their own data folder. If no trustworthy release asset exists, stop and say so in PR.md rather than running `install.sh` from the app.
2. **A setting, off by default.** Per project or per app, "Use a sparse checkout for new worktrees on this project" (plain words). Off keeps today's `git` worktree path. Missing settings read as off.
3. **Only when it is a win.** Use gion only to create a new isolated worktree or agent workspace for a git project the person opted in, never to rewrite the project's main checkout, never for a dirty tree the existing worktree code would refuse, and never as a silent fallback when git fails. After the workspace exists, prefer that Hivra's existing git operations still work if the folder is a valid git worktree; if gion workspaces are not compatible with ordinary git, say so plainly in the UI and keep Hivra operations on the gion tool for that slot only, with tests.
4. **Credentials.** Use the same git / `gh` credentials the person already has. Do not invent a new token prompt, do not read Keychain entries beyond what the existing git path uses, do not log credentials. gion may "borrow" `gh` or the git helper; wrap that so it does not print tokens.
5. **Janitor.** Cleanup of a gion workspace follows the same "nothing is removed without a tap" rule as other worktrees, or a documented equivalent.
6. **Tests** with a local git server or fixture: setting off never calls gion; setting on creates a sparse workspace that can read a path and does not clone the whole fixture's bulky files; a refusal path is unchanged.

## Copy with credit

Add SOURCES.md and credits.json for gion as a pinned tool (Apache-2.0, pin `e68ecda` or the release you actually pin). NOTICE only if you vendor source; a pinned binary still needs a sources row and a credits component.

## Done when

- [ ] Off by default; ordinary git worktrees unchanged.
- [ ] On, a new opted-in worktree can be sparse, with a pin and a checksum, and tests that do not hit the network or the person's real repos.
- [ ] No new secret path; no tokens in logs or commits.
- [ ] Credits and SOURCES updated; no em dashes or en dashes in text a person sees.
