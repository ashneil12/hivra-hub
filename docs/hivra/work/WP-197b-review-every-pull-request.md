# WP-197b: Review every pull request in a connected repository

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 197a, 132 | no |

From PLAN.md, "From Aether", item 5 (every new pull request whoever wrote it, re-review each push until approve, fork
pull requests read-only). Ideas only, nothing credited.

## Goal

For a repository the person turns this on for, every new pull request gets WP-197a's review, whoever opened it, and
each new push gets a fresh one until the verdict is approve. The verdict can be posted to GitHub as a review. A pull
request from a fork is reviewed from its diff only; its code is never run.

## What Hivra has

- WP-197a: the `run-review` reviewer, its verdict and before-and-after screenshots.
- The PR watch (`src-tauri/src/pr_watch/`): watches given pull requests through the person's `gh` (`github.rs`),
  checks out a head into a worktree (`checkout.rs`, `git fetch <remote> pull/<n>/head`), and wakes an owner. It does
  not find new pull requests in a repository by itself.
- WP-132's review guide per head commit. WP-77 (`src-tauri/src/github_issues/`) already polls a connected repository
  through `gh` on a setting.
- Dev copies point `gh` at a stand-in (`MONOCODE_PR_WATCH_GH`).

## What to build

1. **Repository setting** (Settings > Delivery > "Review every pull request"), per connected repository, off by default.
   When on, a poll through `gh pr list` at most every 5 minutes finds new pull requests and new heads, and opens a PR
   watch for each.
2. **Same-repository pull requests** get the full WP-197a review on their head, against the base branch.
3. **Fork pull requests** (head repository differs from the base): read-only. The reviewer gets the diff, the
   description and the checks, never a checkout that runs. No run recipe, no install, no browser against its code. The
   verdict says "Reviewed from the diff; a fork's code is not run."
4. **Re-review each push.** A new head cancels a review in progress for the old head and starts one for the new head.
   After `approve`, a later push is reviewed again. At most one review per head, and a daily ceiling per repository
   (default 20, WP-196b's limit when present).
5. **Posting to GitHub,** a second switch, off by default: "Post the verdict on GitHub". When on, the verdict is posted
   with `gh pr review` as a comment review (`--comment`), never `--approve` or `--request-changes` on the person's
   behalf unless a third switch says so. Screenshots are described in text; images are not uploaded.
6. Each review and each post writes an activity line.

## Rules

- Off by default per repository; posting is a separate switch, also off.
- Fork code is never checked out for running, never installed, never opened in a browser.
- Uses only the person's existing `gh` login; adds no token and stores none.
- A review never merges, closes, labels or pushes.
- Never weakens approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it exists).
- Upstream rules from PLAN.md: `pr_watch` gets one hook for the repository poll; new code in a new module.

## Done when

- [ ] Red first: a test with the `gh` stand-in lists a new fork pull request and asserts no worktree is made and no
      command runs; it fails before the fork rule exists.
- [ ] Tests: a new same-repository pull request starts one review; a new push cancels the old and starts one; approve
      then push reviews again; the daily ceiling holds; posting off sends nothing; posting on calls `gh pr review
      --comment` only.
- [ ] Browser spec `tests/browser/review-every-pr.spec.ts`: the three switches, a seeded fork verdict with its sentence.
      Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check against a test repository stays open until done.

## Not in this package

Reviews on GitLab or other hosts. Approving or merging on GitHub by default. Running fork code in any sandbox.
