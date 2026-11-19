# WP-247: Ask only when it matters, and goals that can't be closed by their own run

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | S | WP-14, WP-215 | yes |

## Goal

Fewer Needs-you items, and no goal quietly closed or loosened by the work it measures.

## Why

CopilotKit OpenBot (MIT, commit 558cba6):
- `shared/bot-prompt.ts` `ASK_TEST_LINES`: ask only when a wrong guess would be hard to undo and the app does not
  already ask, the readings lead to materially different work, or only the person knows. Otherwise make the
  reasonable choice, say so and continue, and ask at the end of a reply that delivers progress.
- Agents are told not to ask about what the app's approval gate already asks, so nothing is asked twice.
- Goal integrity: a repeating goal can't be completed by its own run, and a run can't loosen what ends a goal.
- Research: `reports/openbot-memory-workflow.md` items 4 and 5.

## Build

1. Add the three-case ask test, adapted to Hivra's words and credited, to the first-mate contract
   (`firstmate/model/contract.ts`) and the crew brief. Name the actions the app already gates, so the agent doesn't
   ask about them too.
2. A goal's success criteria can be changed only by Ash, or by the captain with a decision row Ash can overturn,
   never by the run being measured. A repeating goal's own run may report "met" but cannot close the goal.

## Done when

- [ ] Tests: the contract carries the ask test; a run's attempt to edit its goal's criteria is refused; a repeating
      goal stays open after its run reports met.

## Built (11 Nov)

- `firstmate/model/askTest.ts` holds OpenBot's ask test in Hivra's words (credited: `docs/hivra/credits.json`,
  `NOTICE`, `firstmate/vendor/LICENSE.openbot`). The contract's new "Asking" section carries it with the list of what
  the app already asks (the supervised card, sends, deletes, payments, publishes, account changes, merges with the
  switch off, the red list, and the refused key reads). A worker's brief (`brief.ts` status protocol) carries the
  worker's version. `askTest.test.ts` keeps the contract and the module in step.
- `sessions/model/goalIntegrity.ts` is the one rule: Ash changes a goal's criteria; the captain only with a decision
  row; the measured run never. A repeating goal reported met by its own run stays open.
- Where it bites now: Claude Code's `/goal`. A turn that sets or clears it is refused unless Ash typed it in the
  composer (`byOwner`, set only by `onComposerSubmit`, saved on the user block and on a queued message); the registry
  refuses it on send and on steer. A tool call that would run `/goal` (a SlashCommand) is refused in `claude.ts` beside
  the credential block, and in the registry for every other CLI.
- Left open: Hivra has no stored repeating goal yet (routines, WP-217, will). `reportMet` is the seam such a goal calls;
  until then the repeating rule is only proved in tests. No captain path edits a goal today, so the decision-row branch
  is the rule waiting for one. A chat in full access whose CLI skips permissions never asks the app, so a SlashCommand
  there is not seen.
