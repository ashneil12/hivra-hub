# r101 B5 run 3: 20261031-081829-05bc, b5-dump-restart-blind (BLIND, 40 asks)

Run 08:18 to 08:43 GMT (Europe/London), 24.9 min, --grok-sub (grok-4.7 bridge). Restart happened. Grade: **PARTIAL** (B5 PARTIAL, CQ PARTIAL).

## Grader quotes
- B5: "All 40 asks survived the reopen and the +1473s reply accounts for every one, with drafts marked not posted and no item called done without a report. The count line does not match its own list (11 done / 27 parked vs 10 done bullets and 28 parked bullets)"
- Status answer: "+1473s Of 40: 11 done, 1 already there, 1 blocked by your answer, 27 parked."
- CQ: "the lead thread goes quiet from +412s to +1256s while the worker runs"

## 40-ask ledger
40 sent, 0 missing by name (b5-05bc-ledger.md). Nothing lost. "already there" was used as its own bucket (fix 4).

## Risks
1. Plain question: NOT admitted. Chief of Staff's "+412s Still your call on the privacy page: have Tally draft it for you to OK, or leave all three parked." ends in "." not "?", so plainQuestionToAsh() did not fire and there's no Needs you for it. Open for r102 (a question without a "?").
2. No leak: "[MonoCode inbox count]" appears 0 times.
3. No row step in this variant.
- Progress note: did not fire across the 14-minute quiet (one worker, still 0 of 1 done, as the refined rule says). The grader still asks for a line, so that's open.

## Rendered (RENDERED from run, not live)
evidence/r101/critiquito/r101-05bc-{inbox,rail,lead-chat}-RENDERED-from-run-not-live.png
