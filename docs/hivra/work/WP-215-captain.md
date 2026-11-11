# WP-215: The captain decides at its level

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-212 (the Chief of Staff chat), WP-213 (its per-project sessions), WP-156 (standing answers, PR #225) | yes |

## Goal

The Chief of Staff becomes the ship's captain. Ash talks to it; it writes his ask down as a task, hands it to the right
first mate, and answers the questions first mates pass up whenever its rules, Ash's standing answers or a confident
first mate's pick cover them. Only what it can't predict, and what is always Ash's, reaches him, each with the
captain's pick marked. Every decision it makes is recorded with its level and reason, so WP-211 can show it and Ash can
overturn it.

## Why

Ash, 11 Nov 05:33: "Chief of staff is the default agent that can be customised to your personality and it learns ...
its role is tuned to be the ship captain", and "the captain ... makes 95-99% of all decisions for you", with first mates
deciding too "so that let's say the captain only gets about 10% of all decisions and then the owner gets 1% of those".
In 0.16.15 every question an agent asked went straight to Ash (or to Autopilot, which only takes the agent's own pick),
Home's box filed questions as tasks, and nothing recorded who decided what.

## Read first

- [UX.md](../UX.md) "The chain of command": the levels, the 900 / 99 / 1 target and the order the captain answers in.
- The journey doc: <https://claude.ai/artifact/LKCuZMvcJVP4hf64Ukcm3V> ("Who decides what", "When it needs you").
- Autopilot: `autopilot/model/decide.ts` (its three doors: `app autopilot.decide`, a chat's question through
  `hub/model/waitingChats.ts` `takePick`, a tool approval), `redList.ts`, `safeApproval.ts`, `limitResume.ts`. The
  captain reuses these doors; it does not add a fourth.
- The decision store: `src-tauri/src/decisions.rs` (`answer`, `person_only`, `answered_by`); WP-211 adds
  `answer_reason` and overturn. Build on 211's columns if it has landed, else add `answer_reason` here and 211 reuses it.
- WP-156's standing answers (PR #225), WP-176's spend limits, WP-88's Chief of Staff scope (`chief/model/scope.ts`,
  `tools.ts`), the Lead's delegation tools (`firstmate/model/*`).

## Build

1. **The charter.** The Chief of Staff Mono's role text says what a captain is: it owns priorities across projects,
   writes every ask down as a task before any work starts, hands work to first mates and never starts crew itself,
   answers in the order of item 3, and passes up only the owner's kinds. The charter is fixed text in the starter
   template (WP-05), kept apart from a **personality** section Ash edits in Settings › Chief of Staff, beside the engine
   picker that exists today. Editing the personality never edits the charter.
2. **Tasks first, then the right first mate.** One tool, `app captain.handoff { project, department?, title, brief }`:
   it files the task in the project's task list, then hands it to that project's first mate (today the Lead, the
   Coding first mate) through the existing delegation path with the task id, and answers with both ids. With no
   `department` it picks Coding until WP-218 adds others. A handoff to a project the Chief of Staff can't read
   (WP-88 scope) is refused. Home and the project chat show the handoff as one line: "Handed to Coding: <title>".
3. **Deciding at its level.** When "Chief of Staff decides" (item 6) is on for a project, every question from that
   project that would reach Ash goes to the captain first, through the doors Autopilot uses. It answers in this order
   and stops at the first that applies:
   1. Always Ash's: a person-only decision key, anything on the red list, money past Ash's limit (WP-176), anything
      public or sent in his name, keys. These pass up untouched; the store refuses a captain answer on them
      (`person_only`), not only the prompt.
   2. A rule Ash set (the Autopilot rules that exist today).
   3. A standing answer (WP-156) that matches.
   4. A learned preference (WP-216's table; empty until then).
   5. A first mate's recommendation the first mate marks confident, off the red list.
   6. Otherwise one short captain turn in that project's session, which may only pick one of the offered options
      with a one-line reason, or pass it up. At most 20 such turns per project per hour; past that it passes up.
   Steps 1 to 5 are plain code with no model call. An answer is written with `answered_by = "captain:<mono id>"` and
   `answer_reason` naming the step ("standing answer: merge on green", "Coding was confident: retry once").
4. **Passing up.** A passed-up item joins Needs you (WP-210) as it does today, with the captain's pick shown as
   "Chief of Staff suggests: <option>" and its reason. If the captain has not answered a question within 10 minutes
   (its engine is down, or it is out of turns), the question passes up by itself, so nothing waits on the captain.
5. **First mates record what they settle.** One tool, `app decisions.note { project, what, reason }`, writes an
   already-answered decision with the first mate's own `chat:<session>` as `answered_by`. The Lead's brief tells it to
   note every call it would once have asked about (merging on green, a retry, which crew, spending inside its budget).
   The lead tick's own merges and retries write a note too. This is what makes the score line in WP-211 real.
6. **The switch.** The project header's Autopilot switch (WP-213) reads **Chief of Staff decides**. It is the same
   per-project setting: on, the captain decides at its level and Autopilot's existing behaviour runs under it; off,
   everything reaches Ash as today. The default does not change: off on the daily app until Ash turns it on.
7. **What it never does.** It never answers a person-only key, never edits its own charter, never raises its own
   turn cap or a budget, and never answers for a project whose switch is off. Each refusal is a test.

## Done when

- [ ] Tests:
  - the order: each of the six steps decides when it applies and the earlier step wins; a red-line or person-only
    question passes up even when a standing answer or a confident first mate would answer it;
  - the store refuses `captain:` answers on person-only keys;
  - a captain answer carries `captain:<id>` and its reason, and the turn cap passes the 21st question up;
  - a question the captain leaves for 10 minutes passes up once;
  - `captain.handoff` files the task before delegating, answers with both ids, and refuses an unreadable project;
  - `decisions.note` writes an answered decision with the first mate's session and reason;
  - the switch off sends everything to Ash as today, and its default is unchanged;
  - editing the personality leaves the charter as it was.
- [ ] Browser spec `tests/browser/wp215-captain.spec.ts` with example data: a handoff line in the project chat, a
  question answered by a standing answer (shown in Decided for you), one passed up with "Chief of Staff suggests",
  and the header switch, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data); the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-215/`, never pushed).
- [ ] `npm run check` passes.
