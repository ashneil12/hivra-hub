# r97 item 4: c02 BLIND rerun, 20261030-205404-1533 (built from cos/r97 at dab754e7)

Grader: PASS 5/5 (CT, P1, P9, B5, CQ). 8 turns, 100 model requests, 6 min.

## Does the Lead's report match the real tests?
Yes.
- All three workers said "11 passed, 1 failed" (the even-count median test).
- The Lead said "`npm test`: 11 passed, 1 failed" three times, plus "Not fixed: the even-count median stats test still gets 3 instead of 2.5. It was left on purpose."
- The app's own run in the project gave the same result: "11 passed, 1 failed. Test run in the project itself…"
- The Lead never said it was done or green.

## The r97 notes, checked live
- (f) Overreach: PASS. The Lead sent no median fix and reported the failure instead. (In 242d it had delegated one.)
- (e) Tool talk in replies: PASS. The first reply was "Six asks, and the week start is the one open choice. I'll lock that pick into the briefs, save the test rule in your words, and hand each area off before I touch the code."
- Tool talk in thoughts: FOUND. A reasoning headline, "The tool reports it loaded, but the schemas are not visible.", showed as a group header in the chat. Fixed after the run in 1b3063ff, so it now reads "Getting ready" (with a test).
- (g) Buried decision: MISSED live. The ask was "Needs Ash: keep the alive body and correct the backlog, or switch health to `{ ok: true, version }`? I'd keep alive." The "I'd keep …" pick wasn't recognised, so the gate held it as having no recommendation. Fixed after the run in cb04ae50: it now reads as "Would you rather …?" with 2 options, the pick marked, and admitted as a choice (with a test). It hasn't been re-run live.
- Item 1/k, sidebar Working list: no "select:" or raw command text appears anywhere in the captured views. The view snapshots didn't capture the list while it was live.
- Item 3, delegate rows: the stored delegate_task blocks carry job titles ("Health and negative bump", "Shared type and last week", "README health endpoint"). The tool rows sit inside the folded trail, so they're not in the captured view text. On screen, the rows were the agent-note lines 'This chat handed a job to Worker "…"'.
- (i) Done line: "Health and negative bump is done and in the project: TODO.md asks for GET /health as { ok: true, version }." No path.
- (h) The app's test line rendered (the snapshotText wait passed). Its font can't be seen without a shot.
- (a), (b), (c) and (d) weren't exercised: no worker stalled and no app note was queued.

## Shots
None. All four screenshot steps logged: "the hub's window is not on screen (other apps in front), so a window shot would be blank; nothing was brought forward." Following the rules, I didn't bring anything forward. The sidebar Working list and delegate row shots are still owed.
