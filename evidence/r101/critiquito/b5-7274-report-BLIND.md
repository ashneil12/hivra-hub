# B5 run 1 — 20261031-045606-7274 — BLIND (b5-dump-restart-blind), INCOMPLETE

Grade: PARTIAL (B5 NOT-TRIGGERED, CQ PARTIAL). Count line: none, because the restart and the "wat happened" question never happened.

Why incomplete: after 1503s of waiting for the chats to settle, Quit was refused ("1 chat(s) still running; Quit would ask in a Mac dialog"). The hub worker ("Hub dump from Ash", 16 UI fixes) was still committing at +2351s. The run ended after 42 min. The harness stopped its own 4 leftover processes; none of Ash's processes were touched.
The Mac was unreachable from about 05:30 to 07:42 GMT. The run had already finished at 05:38 on its own.

Checks:
- (5b) repeated asks dropped from the raw transcript: seen ("+623s … (3 asks it asked before left out)").
- (5) progress note: none fired. Done stayed at 0 of 1 job, so nothing moved and it stayed silent, as the refined rule says. The grader flagged the silence after +1143s.
- (2)/(8)/(3)/(6): not exercised, because there was no status question and no restart.

Grader quotes:
- B5 NOT-TRIGGERED: "The app refused Quit because a chat was still running, and Ash never asked what happened to the dump."
- CQ PARTIAL: "The replies are walls of numbered lists, the same five lines are re-explained and then mis-filed as Nibbii"

Shots: none. This was a dev run on the Mac; the window was never confirmed on screen.

## Ledger
Asks Ash sent: 40; missing from the status answer: 40.

1. [hub] inbox rows too tall: MISSING
2. [hub] settings page scrolls weird: MISSING
3. [hub] shortcut for a new chat: MISSING
4. [hub] terminal font tiny: MISSING
5. [hub] notes sync between windows: MISSING
6. [hub] pin a chat to the top: MISSING
7. [hub] rail badge doesn't clear: MISSING
8. [hub] today shows finished overnight: MISSING
9. [hub] send button jumps: MISSING
10. [hub] model picker forgets pick: MISSING
11. [hub] undo after archive: MISSING
12. [hub] dark mode code blocks unreadable: MISSING
13. [hub] search in a chat: MISSING
14. [hub] being built groups by project: MISSING
15. [hub] archive button too close to delete: MISSING
16. [hub] dock icon badge wrong: MISSING
17. [hivra] onboarding copy too long: MISSING
18. [hivra] price page says beta: MISSING
19. [hivra] waitlist emails to spam / DKIM: MISSING
20. [hivra] refunds FAQ: MISSING
21. [hivra] hero gif 9mb: MISSING
22. [hivra] signup button colour: MISSING
23. [hivra] mobile nav overlaps logo: MISSING
24. [hivra] privacy page: MISSING
25. [hivra] stripe test mode in staging: MISSING
26. [hivra] dashboard takes 6s: MISSING
27. [nibbii] colour picker recent colours: MISSING
28. [nibbii] export to png cuts edges: MISSING
29. [nibbii] share link: MISSING
30. [nibbii] tutorial skips step 3 on ipad: MISSING
31. [nibbii] undo broken after rotate: MISSING
32. [nibbii] brushes sorted by most used: MISSING
33. [nibbii] app store screenshots out of date: MISSING
34. [nibbii] reply to reviewer (crash on save): MISSING
35. [nibbii] kids mode write-up: MISSING
36. [x] draft hub launch thread: MISSING
37. [x] who asked about hivra last week: MISSING
38. [x] draft android reply: MISSING
39. [x] what people say about monocode: MISSING
40. [x] profile pin idea: MISSING

Rendered chat vs raw transcript: the raw transcript writes each open question once; the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.


(All 40 show as MISSING because there is no status answer to read them from. That is not loss: the dump was restated at +60s, +124s and +202s.)
