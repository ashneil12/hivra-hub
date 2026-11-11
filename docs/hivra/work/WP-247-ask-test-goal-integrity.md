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
