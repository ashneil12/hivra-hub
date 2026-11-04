# WP-77: GitHub issues become briefs

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| E | M | 70 | yes |

## Goal

Labelling a GitHub issue (default label `hivra`) puts it on that project's board as a task, and the project's coding
team picks it up. The task then follows the issue and its pull request to done.

## Why

Orbit turns labelled issues and PRs into tasks and keeps their status in step (Apache-2.0). Hivra already watches
PRs (`pr_watch`) and reads GitHub work items in the Inbox (upstream's `githubTasks.ts`). This is the inward
direction: GitHub feeds the board.

## Read first

- Orbit `docs/github.md` (the sync rules: label creates one task, edits update title and body, close and reopen,
  merged PR completes, closed unmerged cancels, label removed pauses, label added again resumes the same task, a
  deleted task comes back on the next labelled event) and its GitHub integration code and tests.
- Hivra `src/features/inbox/model/githubTasks.ts` (listing work items through the person's `gh`),
  `src-tauri/src/pr_watch/` (read-only `gh`, the `MONOCODE_PR_WATCH_GH` stand-in for tests), the watcher tick
  (WP-11), WP-70.

## Build

1. **Per project, off by default**: Settings for the project gets "Take GitHub issues labelled …", with the repo from
   the project's remote and the label (default `hivra`).
2. **Polling, not webhooks.** A desktop app has no public URL, so on the watcher's tick (at most every few minutes,
   backing off when nothing changes) read labelled issues and PRs through the person's `gh`, reusing
   `githubTasks.ts`'s queries. Reads only.
3. **Sync rules**: port Orbit's rules above. A GitHub task's title and description are read-only in Hivra and show
   a link to the issue.
4. **Pickup.** A new GitHub task is assigned to the project's coding team, which gets it through WP-70's
   person-to-brief path. The PR the crew opens links to the task, and its merge completes it.
5. **No writes to GitHub** beyond what the crew's normal PR flow already does. No automatic comments.
6. Dev copies use the `gh` stand-in and never read a real account.

## Done when

- [ ] Tests with a fake `gh`: a label creates one task and one brief; repeated polls change nothing; edit, close,
      reopen, merge, close unmerged, label removed and re-added; backoff; off by default.
- [ ] `npm run check` passes; a dev-copy check on a test repo.
