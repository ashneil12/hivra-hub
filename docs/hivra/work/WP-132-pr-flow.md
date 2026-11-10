# WP-132: Source-control and review feel: design only

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| T3 parity | L | none | yes |

This package is design only. It adds no product code. A later brief, after Ash picks a slice, would build it.

## Goal

A written design for the rest of T3's git and pull-request feel: stacked pull requests, review guides, viewed marks, and which extra forges are worth adding. Split (side by side) diffs are already WP-116 (Pierre Diffs). This design does not repeat or replace that package.

## Why

T3 is ahead on review feel: a diff layout that is either stacked or split, review guides, viewed marks, local commits in the diff pane, several git hosts, and GitHub stacked pull requests. Hivra's diffs are unified only. A comment on a line becomes a chat message, not a saved review thread. Ash does not review diffs line by line, so the next slice should be thin, and review threads should stay optional.

The behaviour this design responds to is T3 Code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`, user doc `docs/user/source-control.md`, plus the `DiffLayout` setting (`stacked` or `split`, default `stacked`) in that repo's settings contract. Ideas only. No T3 source is copied.

One check could not be repeated. The user doc was read from a later T3 main (`6577c6b`). Reading that same file at the pinned commit needed a git command that was not approved. The parity study already ties review guides, viewed marks, and `DiffLayout` to the pinned commit. Where the later doc is fuller (GitCafe stack landing, the commit picker), this design says so.

## Read first

- Diffs: `src/features/source-control/ui/UnifiedDiffView.tsx`, `WorkingTreeDiff.tsx`, `CommitDiff.tsx`, `SessionChangesDiff.tsx`, `GitChangesPanel.tsx`, `DiffCommentComposer.tsx`, and `src/features/source-control/model/diffComment.ts`.
- A turn's files: `src/features/sessions/ui/SessionReview.tsx`.
- Inbox: `src/features/inbox/model/githubTasks.ts` (provider union), `gitlab.ts`, `azureDevOps.ts`, `jira.ts`, `linear.ts`, `src/features/inbox/ui/InboxView.tsx`, `InboxPrDiff.tsx`, `InboxComments.tsx`.
- GitHub-only git actions: `git_pr_create` in `src-tauri/src/fs.rs` (it shells out to `gh pr create`), `src-tauri/src/pr_watch/`, `src-tauri/src/delivery/merge.rs`, `src-tauri/src/delivery_gate/` (WP-81, the local check before a branch goes to GitHub), `src-tauri/src/land.rs` (a worker patch applied onto the project, not a pull-request merge).
- Not this problem: `src-tauri/src/stacks.rs` is a worktree's ports and services, not a stack of pull requests.

## The design

### Names that are easy to mix up

T3's `DiffLayout` value `stacked` means a unified diff (old and new, one under the other). `split` means side by side. The default is `stacked`. That toggle is WP-116. Unified stays the default there. This package does not add it.

A GitHub stack is a different thing: several pull requests, one on top of the next. "Merge stack" lands the selected pull request and every unmerged layer under it. "Rebase stack" updates the remote branches from the bottom up and does not touch the local checkout. That is in scope here, and it is not the first slice.

### What Hivra already does

The changes panel can commit, amend, push, and create a GitHub pull request, and it can generate the message (`GitChangesPanel.tsx`). Opening one commit already renders that commit's files (`CommitDiff.tsx` takes one sha). A turn's review card lists the files the turn recorded and can keep or undo them (`SessionReview.tsx`). This design does not claim that card hides files a pull or merge brought in. T3 does that. Hivra was not checked for it.

A line comment in the diff is inserted into the chat draft (`DiffCommentComposer.tsx` calls `requestAddToChat`). It is not stored as a review comment on the host.

The inbox already lists GitHub, GitLab, Azure DevOps, Jira, and Linear (`InboxProvider` in `githubTasks.ts`). GitHub pull requests can be merged, squashed, rebased, marked draft or ready, closed, and reopened. GitLab and Azure DevOps can list work, show a thread, post a comment, and load a diff, and that diff is drawn by the same unified view (`InboxView.tsx` calls `gitlabMrDiff` and `azureDevOpsMrDiff`, then `InboxPrDiff.tsx`). Jira and Linear are issue trackers with comments, not git hosts. T3 is the other way round: more git hosts, and no Jira or Linear in this set.

Watching a pull request, the merge gate, and the pre-GitHub check are GitHub only (`pr_watch`, `delivery/merge.rs`, `delivery_gate`). Creating a pull request from the changes panel is `gh pr create` only.

There is no review guide, no viewed mark on a file, and no stack of pull requests.

### Recommended first slice

A review guide on a GitHub pull request that is already open in the inbox.

A guide is a short tour, not a second diff. A few stops, in reading order. Each stop points at lines worth reading. One mark, in plain words "Look closely", means a call only a person can make. Renames, snapshots, and other mechanical files are grouped at the end. Every changed file is on the tour somewhere. Comments already resolved on the host are left out. For a pull request that sits in a stack, the guide covers that layer only.

Why this, and not the other candidates. Ash does not read diffs line by line. Viewed marks are a checklist for someone who does. A commit picker is useful, and part of it already exists, but it does not change how a review feels. Stacked pull requests only pay off if he stacks branches, which this design does not assume. A guide is the piece T3 built for skimming.

Size: M.

What the later brief should keep small:

- GitHub only. The diff and the thread are already loaded for that host.
- One guide per pull request head, on this machine. Not a new object on GitHub.
- The model is whichever one already writes commit text. T3 lets Claude or Codex write a guide. Hivra should not add a provider for this.
- A stop jumps to the existing unified diff. It does not invent a new renderer, and it does not wait for WP-116's split view.
- When the head changes, the guide is out of date until someone asks to rewrite it. Say so. Do not show a stale tour as current.
- Two windows can rewrite the same guide. A write must match the head it was based on, or it is dropped. A late result must not overwrite a newer one.
- A timeout or a model that does not answer is a failed write, not an empty guide. The previous guide, if any, stays.
- No new network call beyond the GitHub read the inbox already does. The guide is written from the diff already on screen.
- Plain labels: "Guide", "Write guide", "Rewrite guide", "This guide is out of date".

Out of the first slice, on purpose: saved review threads, viewed marks, stack merge, stack rebase, any forge that is not GitHub, and the split toggle.

### What to skip

- Line-by-line review threads, unless Ash asks. The chat quote is enough, and the inbox already shows the host's own comments.
- Split and unified as a job for this package. WP-116 owns it. Unified stays the default.
- Cursor Origin. See below.
- Forgejo, Gitea, GitCafe, and Bitbucket until a project he uses is actually on one of them.
- Copying T3's source, its Connect service, or its name.

### Later slices

In this order, each its own brief after the guide, and only if he still wants it:

1. Viewed marks, GitHub only. Size S. Tick a file off in the inbox diff, keep a count, and use GitHub's own marks so the same ticks show on github.com. A file that changes after it was ticked comes back as changed. Do not build a private mark store for GitLab, Forgejo, Bitbucket, or Azure DevOps. Those hosts expose no mark T3 can read, so T3 keeps its own, and the host's website does not show them. That private list is not worth it here.
2. Local commits in the diff pane. Size S. `CommitDiff` already draws one sha. The missing piece is a list of the newest commits in the branch comparison (T3 caps this at 100) and opening one of them. A merge commit is shown against its first parent. This was checked in the later user doc, not only in the pinned study.
3. GitHub stacks. Size M to L. Show a pull request's layer. Merge this one and the unmerged layers under it, through GitHub, respecting the branch rules. Rebase the remote stack from the bottom without changing the local checkout, and stop on the first layer that fails. The later brief should check whether `gh` can already do this before writing a client. Do not build a Hivra-only stack, and do not reuse `stacks.rs`.
4. One extra forge, only for a host he uses. Size L each. Forgejo and Gitea are one integration in T3 (Forgejo's own CLI first, the Gitea CLI as fallback, including Codeberg). GitCafe is a separate host. On the later T3 doc, merging a GitCafe stack lands it there, and updating a branch restacks the layers above. Bitbucket is a token in settings, not a CLI. None of these should be started as a batch.

Creating a GitLab merge request or an Azure DevOps pull request from the changes panel is a small cousin of slice 4, not of the guide. Today that button is GitHub only.

### Forge by forge

| Forge | In T3 | In Hivra |
| --- | --- | --- |
| GitHub | Clone, publish, pull requests, review, comments, auto-merge, stacks, viewed marks that are GitHub's own | Yes. Inbox list, actions, diff, and comments (`githubTasks.ts`, `InboxView.tsx`, `InboxPrDiff.tsx`, `InboxComments.tsx`, `githubPrChecks.ts`). Create from the changes panel (`fs.rs`, `gh pr create`). Watch (`src-tauri/src/pr_watch/`). Merge gate (`delivery/merge.rs`). Pre-GitHub check (`delivery_gate/`). No stacks, no viewed marks, no guide. |
| GitLab | Merge requests via its CLI. T3 calls them merge requests. | Yes for inbox read, comment, and diff (`gitlab.ts`, `InboxView.tsx`). No create from the changes panel. No viewed marks. |
| Azure DevOps | Pull requests via the Azure CLI. Comments are edited on the host website. | Yes for inbox read, comment, and diff (`azureDevOps.ts`, `InboxView.tsx`). No create from the changes panel. No viewed marks. |
| Jira | Not a T3 git host. | Yes, as issues (`jira.ts`). Not a gap in this package. |
| Linear | Not a T3 git host. | Yes, as issues (`linear.ts`). Not a gap in this package. |
| Forgejo | One entry with Gitea. Own CLI, any hostname. | Not in Hivra. |
| Gitea | Same entry as Forgejo. | Not in Hivra. |
| GitCafe | Its own CLI or a saved token. Line comments were not available yet in the later doc. Stacks land through GitCafe. | Not in Hivra. |
| Bitbucket | A saved access token, or an Atlassian email and API token. A declined pull request cannot be reopened. | Not in Hivra. |
| Cursor Origin | Counted as a host package by the parity study of the pinned commit. Not in the built-in registry of the later main that was read for this design, and not described in that main's source-control doc. | Not in Hivra. Skip. |

Searches for those missing names under `src/` and `src-tauri/` found no client. The one "Cursor Origin" string in the tree is a sentence in a plugin-marketplace fixture (`src-tauri/src/plugins/discover/fixtures/cursor-marketplace.json`), not a forge.

### Cursor Origin

Skip, unless Ash says he uses it. It is not one of the hosts the later T3 user doc teaches people to connect, and Hivra has no client for it. A first implementation brief should not mention it.

### Other products named nearby

Orca, Paseo, Cursor, Claude, and Codex come up in the parity study. This package takes no source-control behaviour from them.

- Claude and Codex are only relevant because T3 can ask either to write a review guide. The first slice uses the model Hivra already uses for commit text.
- Orca's fan-out is a different package (WP-135).
- Paseo's relay is a different package (WP-133).
- Cursor's cloud agents are a different package (WP-136). Cursor Origin is the skip above, not that cloud-agent work.

### Enough to pick the first brief

- [x] The first slice is a GitHub review guide in the inbox. Size M. It does not include split diffs, review threads, viewed marks, stacks, or a new forge.
- [x] Split diffs stay with WP-116. T3's word "stacked" on the diff layout is the unified view, not a pull-request stack.
- [x] Every forge above is either a Hivra path or "not in Hivra".
- [x] Cursor Origin is skip unless Ash uses it.
- [x] Line-by-line review threads stay out unless he asks.
- [ ] Ash picks this slice, or names a different one from the later list. That pick is the only thing left before an implementation brief.

## Done when

- [x] The WP doc names a recommended first slice and what is out of scope.
- [x] Every forge is mapped to a Hivra path or to "not in Hivra".
- [x] No product UI or Rust was added.

## Licence

Behaviour in this package is inspired by T3 Code (https://github.com/pingdotgg/t3code at commit `e85e0094dd4617a1eada1ad7961f2132a79e67b2`), MIT. The copyright line read from that project's LICENSE is `Copyright (c) 2026 T3 Tools Inc.` Ideas need no credits.json component. No T3 source file is translated here.
