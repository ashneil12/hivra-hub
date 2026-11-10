# WP-144: Fresh-eyes plan review before a crew starts (Elephant-Goldfish)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Tonight finds (9 Nov 9pm) | M | WP-10 / first-mate plan handoff; pairs with WP-119 tree, WP-117 independent-review | yes |


## Goal

Before a first mate hands a plan to the crew, Hivra can run a cheap "fresh eyes" review: one or more reviewers start with no conversation history, read only the plan (and an optional short reading list), and try to break it. The person (or the first mate, when the person has allowed auto-accept of clean reviews) approves before coding starts.

## Why

[google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) (Apache-2.0, Copyright 2026 Google LLC, commit `b7d9e2706fb96314a0a3123684f53cedd97e7d79`): an Elephant with full context drafts the spec; Goldfish reviewers with zero prior conversation stress-test it; the human approves before implementation. Fits Hivra open needs for first-mate to crew handoff and verification before work. Hivra has delivery gates and independent review skills (WP-81, WP-117) after code; it lacks a structured zero-context review of the *plan* before workers start.

## Read first

- EGM (read-only clone, then delete): `README.md`, `skills/egm-review-loop/SKILL.md`, `agents/design_critic.md` and sibling reviewers, `docs/harnesses.md`. Licence Apache-2.0; copyright line from `pyproject.toml`: "Copyright 2026 Google LLC".
- Hivra: first-mate brief / goal handoff, crew start, WP-10 (lead never edits the project), WP-91 goal graph, `src/features/delivery/`, Inbox decisions (WP-14).
- Do not install EGM as a Claude plugin into Ash's `~/.claude`. Port the pattern into Hivra.

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-144-fresh-eyes-plan-review.md`. SOURCES.md + credits.json + NOTICE for any vendored or translated reviewer prompt files, with exact "Copyright 2026 Google LLC" and Apache-2.0. If only ideas are used (no prompt text copied), SOURCES row only; say so in PR.md.
2. **Review model.** Given a plan document path (or inline brief text) and an optional reading-list of paths, spawn N read-only reviewer workers (default 2) with empty conversation history, each given only the plan + reading list + one persona brief (design critic, implementation readiness, or zoom-out). Collect findings. Tests for empty plan, one reviewer failure, and merge of findings.
3. **Gate before crew.** A project (or Mono) setting, off by default: "Fresh-eyes review before crew starts". When on, `resolveRoute` / first-mate start waits for review status `approved` | `skipped_by_person` before launching builders. Findings appear as an Inbox decision with Approve / Edit plan / Skip once. Tests with the session port stubbed.
4. **Cheap by default.** Reviewers use the cheap worker default (Haiku / DeepSeek / Grok worker), never the lead Fable/Opus, unless the person overrides. Reuse WP-89 / crew defaults; do not invent a second router.
5. **UI.** One line on the crew start card: "Fresh-eyes review: 2 findings, waiting on you" or "cleared". Browser spec Chromium + WebKit for the decision card.
6. **Out of scope.** Do not vendor the whole EGM plugin marketplace install. Do not auto-merge code. No phone app. Security-sensitive remote/cloud review stays out (local reviewers only).

## Copy with credit

- Source: google/elephant-goldfish-model at `b7d9e2706fb96314a0a3123684f53cedd97e7d79`, Apache-2.0, "Copyright 2026 Google LLC".
- Prefer translating short reviewer persona prompts (design critic / readiness / zoom-out) with file headers and NOTICE. Ideas-only is allowed if prompts are rewritten fresh; still name EGM in SOURCES and README Inspirations.

## Done when

- [ ] Setting off by default; when on, crew builders do not start until review is approved or skipped.
- [ ] Reviewers run with empty history and a cheap model.
- [ ] Credits / SOURCES / NOTICE correct if any EGM text was translated; `credits.test.ts` green.
- [ ] Browser spec covers the decision card.

## How a held brief starts

- **Held, not started.** With the setting on, `delegate_task` runs every check that can refuse the call cheaply first (gates, depth, isolation, the model name; for a brief to a Lead: the Lead exists, no project, model, effort or isolation, `whenBusy`; for a worker: a job Ash already answered in its chat), so a brief that would fail is never reviewed. Then it keeps the call (its reading list, cut to 8 short entries, too) with the review and answers at once with a waiting task, `status: "waiting"`. A Mono's own team is made only once the brief may start.
- **Reviewers run after the answer** (the app call is cut at 35 s and the MCP hop at 40 s). The answer says "still running"; asking again says so too, and the person is asked only once the reviewers have answered. A reviewer that does not answer in 4 minutes is stopped, and all of them together get 10 minutes, then the person is asked instead. A review is clean only when every reviewer says `NO CONCERNS` and nothing else: an empty, missing or unreadable reply is a reviewer that did not answer, never a pass, so a brief that asks the reviewers to stay quiet cannot approve itself.
- **What a decision covers.** The review keeps a hash of the call and the chat that asked. The same request ID with any other call (an edited brief) or from another chat is a new review: the held brief is replaced, the reviewers run again, and the Inbox question is a new one (`fresh-eyes/<request>/<hash>`). What starts is what was reviewed. The card shows the first lines of the brief it would approve and carries its hash; an answer about a brief that has since been replaced is refused, and the question for the brief now held is asked. A brief that started is spent: its approval does not start it again (a worker that was cancelled needs a new review). Edit plan ends the brief it was said about: the held copy is dropped.
- **Only the person answers.** An answer in the Inbox or Home counts when it was given by the person (`user` or `person`); `ask_person` from a chat with the review's key does not, and the store refuses it, so the question stays in the person's Inbox (`decisions.rs` `person_only`). The app closes its own questions as `app:fresh-eyes`.
- **Approve, Skip once, or the person's answer in the Inbox** ask `tasks.delegate` again under the same request ID with the call that was reviewed, the way a waiting worker starts. The usual checks, worker limits and waiting line apply. Edit plan does not start it. The Inbox question closes with the decision, and on `task_cancel`.
- **Kept in the app's database** (hub document `fresh-eyes`), so it survives a restart and every window reads the same record. Reviews are capped (40; finished ones go first, anything untouched for two weeks goes) and a brief over 150,000 characters is refused. When the hold cannot be saved or read the delegate is refused in plain words and nothing is held.
- **Nothing waits forever.** At startup and every half minute, a review whose reviewers died with the window runs again (a lease in the record says no window is on it), one never asked is asked, and an approved brief starts. A chat that may not ask (a Lead under a Mono) has its question asked as the app. A start that fails is tried again after 30 seconds and 2 minutes; when every try failed the chat that asked is told and the person is asked to try again or drop it. Each give-up is a new question, so an answered "Try again" is never taken for the next answer.
- **One start.** The start is claimed with a lease written in the record on the revision just read, so two windows start it once.
- The brief shows in `task_status` under `waiting` and `task_cancel` takes it back. `delegate_task` accepts `reading` (up to 8 entries, each a path and its text).
- A dev seed does not copy the `fresh-eyes` document (`scripts/hub-seed-dev.mjs`): a held brief names Ash's real chats.

## Licence

Apache-2.0, Copyright 2026 Google LLC (elephant-goldfish-model). Follow Hivra vendor rules for any copied or translated files.
