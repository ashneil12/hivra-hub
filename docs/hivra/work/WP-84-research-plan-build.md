# WP-84: Big tasks are researched and planned before they are built

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| G | L | 70, 72 | yes |

## Goal

For a task where a wrong choice would be expensive, the first mate doesn't send one crew straight to code. It runs the
task in short phases: research what exists now, write down what should exist, then build. Each phase leaves a short
document on the task that the person can read and comment on in minutes, before a large PR exists. Small, clear tasks
still go straight to building.

## Why

Ash, 4 Nov: shared [HumanLayer](https://github.com/humanlayer/humanlayer) (Apache-2.0). Its Research, Plan,
Implement (RPI) workflow rests on one point: agents write code faster than a person can review it, so the delay
moves to review, and a short document is much cheaper to correct than a big PR. Research records only facts about
the current code, so wrong facts are caught before they become design choices. Its 22 skills are Apache-2.0 and
written carefully, so Hivra copies them.

**What it replaces, so nothing stacks** (Ash's bloat rule): for a phased task, the phase documents replace the
first mate's single long brief. pstack still guides the worker while it builds, WP-40 still decides done, and WP-81
is still the one review before GitHub. The RPI skills are marked "only when invoked by name", so they add nothing to
the skill index a session reads: the first mate calls them, and Ash never types a slash command.

## Read first

- HumanLayer: `apps/docs/explanation/workflow-phases.md`, `apps/docs/explanation/tasks.md`,
  `apps/docs/reference/skills-workflows.md` (the four workflows and the skill conventions),
  `apps/docs/guide/skills-workflows.md`, `apps/docs/reference/subagent-models.md`, and
  `apps/riptide-rpi-claude-plugin/` (its `LICENSE` and all 22 `skills/*/SKILL.md`).
- Hivra: WP-70 (tasks, comments as steering), WP-72 (docs), WP-13 (crew routing), WP-14 (decisions), WP-40 (gates),
  WP-41 and WP-45 (pstack and its routing), `src-tauri/src/firstmate/`.

## Build

1. **Copy the skills** into a Hivra plugin, `hivra-rpi`, in WP-30's format, with HumanLayer's Apache-2.0 `LICENSE`,
   a `NOTICE` entry and credits.json. Keep each skill's text. Change only what must change: Linear tickets become
   Hivra tasks, `.humanlayer/tasks/<slug>/` becomes the task's folder, and slash-command wording becomes "the first
   mate runs this phase". Leave out `ci-commit`, `configure-workspaces` and `setup-worktree` (Hivra has its own).
2. **Three paths.** The first mate picks one when it turns a task into work, and says which and why on the task:
   - **Straight build** (HumanLayer's Oneshot): clear and small. Today's behaviour.
   - **Research, plan, build** (RPI): research questions, research, a design discussion, a structure outline, then
     building.
   - **Product first** (PRD-Oriented): adds a product document and a technical one, for a large change the person
     should approve in product terms first.

   The person can change the path on the task at any time. A project setting sets the default (straight build).
3. **Each phase is its own crew run** with a fresh session, on the same task. It writes one numbered document into
   the task's folder, shown on the task (WP-72's viewer). The next phase reads the earlier documents. When documents
   disagree, the later one wins, and for how the code behaves today, the code beats any document (HumanLayer's rule).
4. **The person reviews where it is cheap.** After research and after the design discussion, the task waits on the
   person by default (WP-14 decision: "Looks right", "Change this", "Skip to building"). A comment on the task or its
   document reaches the next run as steering (WP-70). A project setting can let a phase continue without waiting.
5. **Iterating.** "Change this" runs the matching `iterate-*` skill on the same document with the person's words,
   rather than starting the phase again.
6. **Building** uses `implement-outline` and then the normal crew path (WP-81's gate when it's on, WP-40's gates).
   The PR body links the research and design documents.
7. **Sub-agent models.** Keep HumanLayer's split (cheap models for searching, the main model for judgment) as the
   phase defaults, overridable in the project's settings like WP-13's routing.
8. **Dev copies** run the phases with the fake Claude (`scripts/fake-claude.mjs`), never a real login.

## Done when

- [ ] Tests:
  - a small task takes the straight path and no phase documents are written;
  - a phased task writes research, then design, then waits for the person;
  - "Change this" runs the iterate skill on the same document;
  - a comment on the design document reaches the next run;
  - the RPI skills don't appear in the always-on skill index;
  - the PR links the phase documents.
- [ ] Browser spec: a phased task shows its documents in order, with the decision at each review point.
- [ ] `npm run check` passes. Dev-copy check with the fake Claude.
