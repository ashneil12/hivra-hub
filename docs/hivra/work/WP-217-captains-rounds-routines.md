# WP-217: The captain's rounds, the morning brief and routines

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | M | WP-215 (the captain decides), WP-216 (the batch times), WP-160 (the lead tick) | yes |

## Goal

The captain walks the ship on a clock. Every hour (every 15 minutes while work runs) it checks each project, unblocks
what it can, and passes up only what it can't. Each morning Ash gets one message with what happened overnight and his
decisions; each evening, one paragraph. When Ash asks for the same thing again and again, the captain offers to make it
a routine.

## Why

Ash, 11 Nov 05:33: "things are always kept track and done e2e. With ways of handling routines etc that would improve
the workflow as it learns you." The tips he shared: an hourly routine that reviews every session and unblocks or nudges
it. In 0.16.15 the lead tick (WP-160) watched one project's Lead at a time, the morning note was a habit that listed
ids, and automations started from someone else's templates.

## Read first

- [UX.md](../UX.md) "The chain of command"; the journey doc's "Nights and routines"
  (<https://claude.ai/artifact/LKCuZMvcJVP4hf64Ukcm3V>).
- The lead tick: `leadTick/model/*` (`tick.ts`, `store.ts`, `setting.ts`) and `useLeadTick.ts`.
- `autopilot/model/limitResume.ts` (pausing at a usage limit and resuming after the reset).
- `chief/model/habit.ts` (the morning habit, `MORNING_HABIT_ID`), `automations/model/*`, the work log (WP-157).

## Build

1. **The rounds.** For each project whose "Chief of Staff decides" switch is on, every hour, and every 15 minutes while
   any of its workers runs: first the lead tick's plain-code pass (stopped workers, red checks, pull requests ready,
   questions waiting, limits). Only if that pass found something it couldn't settle, one captain turn in the project's
   session with what it found, which may nudge a first mate, answer at its level (WP-215) or pass up. It writes one
   line to the work log ("Rounds: nudged Coding about the stopped commit guard; 2 settled; 1 for you"). Off when the
   switch is off. A dev copy runs it only when a test turns it on, as with habits today.
2. **Limits.** When a usage limit stops a project's work, the rounds note it once, pause that project's rounds and
   resume them after the reset through `limitResume.ts`. No turn is spent while paused.
3. **The morning brief.** At the first batch time (WP-216), one message in the Home chat replaces the morning habit's
   output: what shipped overnight, what is running, "Decided for you: <count>" with the top three, and the owner batch
   under it. One message, not three. The morning habit's stock text moves into the brief; an edited habit stays as Ash
   wrote it.
4. **End of day.** At the last batch time, one paragraph: what got done, what is still running, what is next.
5. **Routines from repeats.** When Ash asks the captain for the same kind of thing three times within two weeks (the
   same ask in other words, judged by the captain and confirmed by plain code that the three turns exist), it offers
   once: "You've asked for <this> three times. Make it a routine, <guessed schedule>?" Yes makes an automation owned by
   the Chief of Staff, shown as a **Routine**. No is remembered for that kind.
6. **Routines start from Ash's things.** The Routines list (today's Automations) opens on routines for his projects and
   Monos, and the template gallery of other people's examples goes behind "More ideas".

## Done when

- [ ] Tests:
  - the rounds run on their clock only for projects with the switch on, run the plain-code pass first, and spend a
    captain turn only when the pass left something;
  - a rounds turn answers through WP-215's order and writes one work log line;
  - a limit pauses the rounds and the reset resumes them, with no turn spent while paused;
  - the morning brief is one message holding the batch; an edited morning habit is kept;
  - the repeat offer appears after three asks, once, and yes makes a routine owned by the Chief of Staff;
  - dev copies don't run the rounds unless a test turns them on.
- [ ] Browser spec `tests/browser/wp217-rounds.spec.ts` with example data: a rounds line in the work log, the morning
  brief in the Home chat, the routine offer and the Routines list, with 1440 × 900 screenshots.
- [ ] Before and after screenshots in the PR (example data); the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-217/`, never pushed).
- [ ] `npm run check` passes.
