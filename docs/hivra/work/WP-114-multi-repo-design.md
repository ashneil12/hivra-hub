# WP-114: Design only: a project that holds several repos

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | S | none | yes |

## Goal

A one-page design for how a Hivra project can hold more than one git repository, so a person and their agents can see changes, commit and run work across those repos without pretending they are one checkout. This package writes that design. It does not change product code, tests, or settings.

## Why

Ash asked Hermes for T3's most wanted missing feature: projects that span several repos (115 upvotes, discussion 7041). T3 users who work in a VS Code multi-root workspace cannot see git changes across them. The T3 notes marked this "design first." Hivra's project model is built around one directory on disk (`src/features/projects/model/`). The main-branch changelog mentions "multi-repository staging and commits" in regression coverage, so the design must start by finding what, if anything, already exists (nested repos, submodules, or a test-only path) and must not invent a second model on top of a hidden one.

This is a design package only. A later package, after Ash is happy with the page, would implement it.

## Read first

- Hivra: `src/features/projects/model/` (especially `projectData.ts`, `projectLocation.ts`, `projectScope.ts`, `projectGroups.ts`), how a chat and a worktree pick their checkout, `src-tauri/src/worktrees.rs`, the changes panel (`GitChangesPanel.tsx`, `src-tauri/src/fs.rs` git helpers), first-mate checkout rules (`checkout_guard.rs`). Search for "multi-repository", "multi-repo", "submodule" and "nested" before concluding nothing exists.
- T3 notes on projects: a project is a directory on one machine, and a workspace of several repos was the top open request (115 upvotes).
- WP-82, WP-87 and WP-110 (worktrees, stacks, worktree-per-chat) so the design does not break parallel crews.

## Build

1. **Read the code first.** In PR.md, list what already works for more than one repo (even if it is only a test) and what does not, with file paths.
2. **Write one page** at `docs/hivra/work/WP-114-multi-repo-design.md` (replace this stub's "the design" section, or keep this header and fill the section below) covering, in plain words:
   - What a "project with several repos" means in Hivra (several checkouts under one project the person opened, not a monorepo tool and not a hidden virtual filesystem).
   - How the person adds, removes and sees those repos.
   - How the changes panel, diff, commit, push and PR work across them (one commit per repo, never a cross-repo commit that git cannot represent).
   - How a chat, a worktree, a crew worker and a first-mate brief pick which repo they are in, and how a task that spans two repos is described.
   - What happens when one repo is missing, dirty, or not a git checkout.
   - What is out of scope for a first implementation (submodules as a first-class model, vendor/ trees, automatic discovery of every git folder on the machine).
   - A recommended first slice that could be a later WP, with size and risks.
3. **No product code.** No changes under `src/`, `src-tauri/`, or `tests/`, except you may add the design doc and, if a source is cited, a SOURCES.md line. No new setting, no migration, no UI.

## The design

A project stays one folder. Hivra already keys it by the whole path (`projectKey` in `src/shared/lib/paths.ts`), because folder names repeat across checkouts. "Several repos" means that same project also names other git checkouts, each a real folder on disk. It is not a monorepo tool, and it is not a hidden filesystem that pretends those folders are one tree.

This is the gap behind T3's top request. A person who keeps an API and a web app as sibling checkouts (the way a VS Code multi-root workspace does) cannot see both from the one project they opened. T3's own project is also one directory on one machine. Hivra should not add a second project type to fill the gap.

### What already works, and what this is not

Three things already cover more than one checkout. A later build reuses them. It does not replace them.

A Mono can already be given several projects (`projects` on the Mono, added from the rail in `MonoProjects`). Its Changes view groups a session's files by the git checkout that holds each file, keeps a commit draft per checkout, and commits and pushes only the checkout on screen (`MonoChangesView`, and the test "preserves repo drafts and stages, commits and pushes only in the chosen repo"). That is one Mono working across projects. It does not make one project hold several repos.

Any changed file is located with `git rev-parse --show-toplevel` (`git_locate_file` in `src-tauri/src/fs.rs`). Run from inside a nested checkout, that command returns that checkout's own top level, so a nested repo or a submodule is attributed to itself rather than to the folder that contains it. The test `locate_files_distinguishes_repos_worktrees_and_deleted_parents` covers two repos, a worktree, a deleted parent, and a file outside git. A file in no repo locates to nothing and cannot be committed. A selected-file commit refuses a path from another top level: "Selected files must belong to this repository". This is how a session that already touched two checkouts is reviewed. It does not list a sibling the session has not touched, and it does not scan the tree.

The project changes panel (`GitChangesPanel`) and the git commands (`git_commit`, `git_push`, `git_pr_create` and the rest) each take one working directory. Project groups on the rail are a visual grouping of separate projects (`projectGroups.ts`), not a workspace. `git_github_repositories` is the GitHub remote of one working copy, plus its parent when it is a fork. The worktree janitor's one-level walk classifies leftover worktrees. Neither one discovers project members. There is no WP-110 (worktree per chat) in this tree.

### How the person adds, removes and sees them

The folder the person opened stays the project. If that folder is a git checkout, it is the first checkout. The person adds a member by picking another folder. Hivra shows the canonical path, using the same path helpers the git commands already use, and adds it only when all of these hold:

- The folder is its own git top level.
- It is not the project folder, and it is not inside the project checkout.
- It is not a worktree of a checkout already on this project. Worktrees stay on the worktree list.
- The same path added twice is one member.

A folder that is not a checkout is refused, with the reason. Nested repos, submodules and `vendor/` trees are not attached by scanning.

Removing a member drops the link only. It never deletes the folder, its worktrees or its commits. A member sits outside the project folder, so the usual "this path is inside the folder, so it is safe to delete" proof does not apply, and must not be used as an excuse to delete.

The person sees each member on the project: its name, path and branch, and whether it is clean, dirty, missing or unreadable. The project changes panel lists each checkout the way the Mono Changes view already does, one tab each, including a clean member so it can still be pushed. The single-directory diff stays the view of whichever checkout the open chat is in.

The member list is data about this project, stored with its other local settings under the existing project path. It is not a new project record and not a new database table. A path read back is untrusted: if it fails the checks above it is shown as unusable and not opened. A write from one window must be based on the list that window last read, so it cannot wipe a member another window just added.

### Diff, commit, push and pull request

Each checkout keeps its own status, diff, file selection, message, commit, push and pull request. The commands that exist today are the ones that run, each with that checkout's directory. There is no control that commits, pushes or opens one pull request across repos. Git cannot make that commit, and the selected-file check already rejects it. A person who wants both repos updated makes two commits and, when they want review, two pull requests. The screen can show both side by side. It must not offer to fold them into one.

### How a chat, a worktree, a crew worker and a brief pick a repo

A chat has one working directory (`cwd` on the session) and at most one worktree of that same repo (`worktreeCwd`). Opening the project opens the project folder. Starting a chat in a member is a choice the person makes, the same kind of choice as opening a worktree. Hivra does not silently pick "the first repo".

A worktree is created from one repo (`git_worktree_create` takes one `cwd`). The ready-worktree pool (WP-82) is per repo. A worktree's stack (WP-87) belongs to that worktree: its own ports, env and services. A second member does not share the first member's pool, ports or data folder. This design does not depend on a worktree per chat.

A crew worker's brief names one primary checkout (`mainCheckout` on an own-checkout brief in `brief.ts`) and must be inside the disposable worktree it was launched in, not that primary checkout. The launch uses the chat's one folder (`agentAppTasks.ts`). A first mate still only reads. The checkout guard snapshots the one directory the turn was given (`checkout_guard.rs`) and compares it when the turn ends. A task that spans two repos is two briefs, one per repo, whose words say they are the same job. It is not one checkout, one worktree or one commit.

The first slice does not let one chat write into every member. Showing a member's status is not permission to edit it. A later slice that does let one chat write in several repos has to snapshot every repo that chat can write. Otherwise the guard goes blind on the others, which is already true for any write outside the chat's directory and must not get worse on purpose.

### Missing, dirty, or not a checkout

A missing member does not stop the project, or the other checkouts, from opening. It shows as missing. Nothing starts a chat, a worktree or a commit there until the folder is back or the person removes the link. A dirty member shows its own diff. Dirt in one repo does not block a commit, a push or a new chat in another. A member whose `.git` is gone shows as not a checkout and offers no commit. Failing to run git, or a git command that times out, means "could not read this checkout". It does not mean "this is not a repo", and it is not a reason to drop the member.

### Out of scope for the first slice

Submodules as members of their own. `vendor/` and other nested trees. A scan that attaches every git folder on the machine or under the project. A cross-repo commit, push or pull request. Turning project groups, or a Mono's project list, into this feature. A worktree that belongs to two repos. A new setting, a migration, or a second project record.

### Later package

Medium. A follow-on can ship it. This page does not.

The slice is a member list on the project the person opened, add and remove as above, and the project changes panel reuses the Mono Changes checkout tabs plus the existing one-directory commit, push and pull-request commands. A chat is aimed at a member only when the person picks it. There is no new commit path.

Risks to plan for:

- The checkout guard and the brief both assume one directory. Widening what a chat may write, without snapshotting every writable checkout, hides edits.
- Two windows can save the member list at once. A blind overwrite drops a member.
- Remove must never delete the member folder. It is not inside the project.
- People will expect one pull request for the whole job. Two pull requests have to look deliberate, or the screen looks broken.
- A nested repo that `git_locate_file` already splits must not also be a member, or the same files show twice.
- The pool and the stack are per repo and per worktree. A member must not reuse another repo's slot, ports or data folder.

## Copy with credit

Ideas from T3 Code need no credit. There is no code to vendor.

## Done when

- [x] The one-page design is in `docs/hivra/work/WP-114-multi-repo-design.md` and can be read on its own.
- [x] PR.md records what the current code already does for more than one repo, with paths.
- [ ] `git diff --stat origin/main` shows only docs (and SOURCES.md if a line was added). No `src/`, `src-tauri/` or `tests/` changes.
- [x] No em dashes or en dashes in the design text a person will read.
