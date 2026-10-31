# B5 run 2 (r103), e46f: b5-dump-restart-partial-blind, BLIND, graded FAIL
Run: evidence/realtest/20261031-134836-e46f (13:48 to 14:29 GMT, 39.8 min). Code: cos/r103 at 8f1e4272.
Shots: r103-e46f-{inbox,rail,lead-chat}-RENDERED-from-run-not-live.png (rendered from the run's snapshot, not live). Retina rail check passed.
Ledger: ../b5-e46f-ledger.md (40 asks, 22 not named in the status answer: grouped as "and N more").

- B5 FAIL: "The reopen Inbox was a single pick card, so taking one row of a multi-row card was impossible ('0 rows'), and the later count does not match the card: it says the one item waiting is the Today-overnight decision while the rail shows Apply/Discard."
- CQ PARTIAL: "pushed back on the four red-lines with one recommendation, and summarised without a wall of text. Four replies leak the internal note '(1 ask it asked before left out)'" (that note was the harness transcript's own, not the Lead's).
- Harness fix (r102 pick reply vs "wat happened") NOT confirmed live: the Lead only had one ask on the Inbox at reopen, so there was no row to answer.
- Item 2 held: no wall ("summarised without a wall of text"); first reply +139s here (the dump came in 4 messages; acked as "35 product asks plus 5 on X").
- Fixed after this run: 5ac08c63 (a status reply's new ask joins the open card, not replaces it; yes/pick asks get Needs Ash from the first reply; done only when shown; transcript note labelled), then the "and N more" rule removed.
