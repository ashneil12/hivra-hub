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

## Addendum (10 Nov 2026): a plan waits for approval before a GitHub issue is built

Source: Jean (coollabsio/jean, Apache-2.0, Copyright 2025 Andras Bacsai). Its Mr Robot beta polls open issues, makes one worktree per issue, drafts a plan and executes only an approved plan. Ideas only. No Jean code or prompt text is copied, so there is no NOTICE entry.

### Why

Step 4 of this package hands a new GitHub task to the project's coding team through WP-70's pick-up path. WP-70 has no plan step, so a labelled issue can go straight to a build. Hivra already has the parts for a plan stop: `/plan` in `src/features/sessions/model/plan.ts` (the plan block, "Build approved plan", and an approved text that can be edited in `src/app/App.tsx`), and the decision card in WP-14. WP-144 holds a brief for review, but it reviews the brief the first mate writes, not the plan the crew writes after reading the repo.

### Build (adds to steps 4 and 6 above)

7. **Plan first.** A pick-up from a GitHub task starts the crew in plan mode. The crew reads the issue and the repo, writes a plan and stops. It changes no files, pushes nothing and opens no PR. Providers without a plan mode get the same card with a prompt that asks for a plan and forbids edits; if that cannot be enforced for a provider, the switch stays off for that provider.
8. **One decision.** The plan lands in the Inbox as one card: Approve and build, Edit plan, or Stop. Approve starts the build from the plan text the person approved, through the same path as `/plan`. Edit plan saves the edited text as the approved text. Stop cancels the task's crew.
9. **Per-project switch.** "Plan before building labelled issues", on by default for a project that takes GitHub issues (Ash to confirm the default). Off keeps today's direct pick-up. The switch sits with WP-77's setting in step 1.
10. **Board words.** WP-70 shows the task as "planning, waiting on you", in the same plain words as WP-15. No new status category.
11. **Stale cards are refused.** The card carries a hash of the plan it shows. An answer about a plan that has since been replaced is refused, and the new plan is asked, the way WP-144 handles a changed brief.
12. **Not taken from Jean:** polling every open issue. WP-77 reads only labelled issues, so no unlabelled work starts.

### Done when (adds to the list above)

- [ ] With the switch on, a labelled issue produces a plan and no branch, commit, PR or file change before approval.
- [ ] Approve builds the approved text; Edit plan builds the edited text; an answer about a stale card is refused; Stop leaves no worker running.
- [ ] Switch off gives today's pick-up exactly (test with the fake `gh` already described above).
