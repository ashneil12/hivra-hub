# WP-86: Every commit says which agent, chat and task made it

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| G | M | 70, 78 | yes |

## Goal

Every commit a Hivra agent makes carries a line naming the chat and task it came from, so the task shows its
commits, the activity log shows who made each one, and a PR shows which agents worked on it. Lines an agent wrote
that the person later commits by hand are still credited to the agent, marked as inferred.

## Why

Ash, 4 Nov: shared [HumanLayer](https://github.com/humanlayer/humanlayer) (Apache-2.0). Its `packages/git-attribution`
does this carefully with two kinds of evidence: a trailer stamped by a `prepare-commit-msg` hook that lives in the
agent's environment (never in the repo's own hooks), and a journal of line hashes the agent wrote, matched later by
content overlap with a guard against boilerplate. A commit neither claims is the person's, and only its counts are
kept. With several crews and Grok all committing to Hivra, this answers "which run made this change?" without
guessing from branch names.

**What it replaces:** the hand-written `Co-Authored-By` and session lines in crew commits become the trailer this
package stamps. Nothing else is added to a commit.

## Read first

- HumanLayer: `packages/git-attribution/src/index.ts` (the design note at the top), `gate.ts`, `git-env.ts`,
  `session-attribution.ts`, `attribute-commit.ts`, `attribute-pull-request.ts`, `redact-human-commit.ts`,
  `evidence/trailer/` (`session-hooks-dir.ts`, `forwarded-hooks.ts`, `hook-scripts.ts`, `session-trailer.ts`),
  `evidence/journal-overlap/`, `evidence/commit-ledger/`, and the tests.
- Hivra: how a crew's environment is built (`src-tauri/src/firstmate/`, WP-13), WP-70 (tasks), WP-78 (activity log),
  WP-81 (no-mistakes rebases; trailers survive a rebase), `src-tauri/src/pr_watch/`.

## Build

1. **Copy the package** with its Apache-2.0 `LICENSE`, a `NOTICE` entry and credits.json, into
   `src/features/attribution/` (TypeScript, with its tests), or translate the hook and the ledger to Rust where the
   crew's environment is built in Rust. Say which in the PR.
2. **Trailer.** A crew's process gets `core.hooksPath` through its environment (`GIT_CONFIG_*`), pointing at a hooks
   folder in Hivra's data folder that adds `Hivra-Chat: <id>` and `Hivra-Task: <id>` and then runs the repo's own
   hooks (HumanLayer's forwarded hooks). The repo's `.git/hooks` and config are never changed.
3. **Journal.** Each crew run records hashes of the lines it wrote. When the person later commits those lines
   themselves, the commit is credited to that run as inferred, gated against boilerplate as HumanLayer does.
4. **Ledger.** A small table maps commit to chat, task and tier (confirmed, inferred, person). A commit made by the
   person with no agent lines keeps only counts (files, lines), never its message or diff.
5. **Where it shows:** the task's commits (WP-70), "commit by <agent> for <task>" in the activity log (WP-78), and on a
   PR, the agents and tasks behind its commits.
6. **Dev copies** use their own hooks folder and ledger, and tests use a temporary repo.

## Done when

- [ ] Tests (ported from HumanLayer's where it has them):
  - a crew's commit carries both trailers and the repo's own hooks still run;
  - the repo's hooks and config are unchanged afterwards;
  - the person committing an agent's lines is credited as inferred, and boilerplate isn't;
  - a plain person's commit keeps only counts;
  - a rebase keeps the trailers;
  - a PR lists the tasks behind its commits.
- [ ] `npm run check` passes.
