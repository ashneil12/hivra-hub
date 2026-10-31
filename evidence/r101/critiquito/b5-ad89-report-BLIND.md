# r101 B5 run 2: 20261031-074309-ad89, b5-dump-restart-partial-blind (BLIND, 40 asks)

Run 07:43 to 08:11 GMT (Europe/London), 28.3 min, --grok-sub. Restart happened (own Quit path, reopened in background). Grader (our bench grader, rule-(h) aligned in r101): **PARTIAL** (B5 PARTIAL, CQ PARTIAL).

## Grader quotes
- B5: "The restart answer keeps all 40 asks, omits the empty running bucket, and does not call the X drafts posted or the thrown-away hub preview done ... The blind step failed: those four decisions are one blob, not a multi-row card, so one row could not be answered"
- Status answer (+1679s): "Of 40: 4 done, 4 blocked by your answers, 32 parked."
- CQ: "The +338s recap is a wall of lists plus a model-status line, and later statuses repeat the same hold instead of staying short."

## 40-ask ledger
Count: 40 of 40 accounted (4 done + 4 blocked + 32 parked). By name: 17 named individually; the 23 the name ledger marks MISSING all sit in groups the answer names: "the twelve hub screen fixes" (hub #1, #7-16) and "the other Hivra and Nibbii bugs are with Chief of Staff" (Hivra #17, 21-23, 26; Nibbii #27-33). Nothing lost. Fix (1) seen live: #37 and #39 (X lookups) "parked because the lookup failed and there is no X access from here".

## The three risks
1. Plain-question asks with no pick: NOT exercised. The Lead used a marker with a pick; no waiting entry has plain:true. Unit-tested only.
2. Inbox count note in Ash's bubble: no leak. "[MonoCode inbox count]" appears 0 times in transcript.md and evidence.json.
3. Row answer on the partial run: NOT possible. The Lead put its four hub decisions in ONE marker question, so the driver hit "no row 0 on a multi-row card (0 rows)". Fix (6) (held rows) is unit-tested only, not proven live.

## Other findings
- The progress note did not fire (the worker went quiet from +380s to +967s with done still 0 of 1, which matches the refined rule).
- The 5b dedupe worked: "(1 ask it asked before left out)".
- Worker built 12 fixes in a preview, then the Lead threw it away (Settings touch), and the handoff to the Hub lead did not land. That is honest but wasted.

## Rendered (RENDERED from run, not live)
evidence/r101/critiquito/r101-ad89-{inbox,rail,lead-chat}-RENDERED-from-run-not-live.png. The chat is rebuilt from evidence sends and texts; the last reply may show cut short where the run only logged a partial stream.
