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

## Licence

Apache-2.0, Copyright 2026 Google LLC (elephant-goldfish-model). Follow Hivra vendor rules for any copied or translated files.
