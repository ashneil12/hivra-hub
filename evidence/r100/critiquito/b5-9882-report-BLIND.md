# B5 run 1 (r100), BLIND: 20261031-015940-9882, build cos/r100 @ 43c120b

Grader: PARTIAL (B5 PARTIAL, CQ PARTIAL). Ledger below re-made with the r100 Inbox-card fix (scripts/hub-realtest-asks.mjs); grader rules untouched.

Count line (rendered, after quit and reopen): "Of 40: 13 done, 4 waiting on you, 21 parked, 2 lost." then "4 decisions are on your Inbox card."
- Total 40 = asks sent (a) ok. 13+4+21+2 = 40.
- Waiting on you 4 = the Inbox card ("Tally lead · 4 decisions") (h) ok. No "0 running", no empty bucket (h) ok. Nothing called running (b) ok.
- Strip/rail: one Needs you on Tally (grader). Inbox card options read "Suggests: No. Leave the mail and DNS alone." (no repeated opening words) (e) ok.

Still wrong (grader quotes):
- "+2101s status is a long recap that reprints the four Inbox decisions instead of a short done/running/waiting/lost line"
- "the two X lookups move from parked (+639s) to lost (+2101s) without new information"
- "+639s says the hub preview is already in while the worker is still editing until +1960s"
- "Chief of Staff recommends a Stripe look-and-report (+489s) while Tally's pick is No, don't open Stripe"
- No Chief of Staff ask was on the Inbox after the reopen, so (c) was not exercised live in this run.

Shots: none. The window was never on screen (splash only), so no shots were taken.

Asks Ash sent: 40; missing from the status answer: 0.

1. [hub] inbox rows too tall: parked
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: parked
4. [hub] terminal font tiny: done
5. [hub] notes sync between windows: done
6. [hub] pin a chat to the top: parked
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: parked
9. [hub] send button jumps: parked
10. [hub] model picker forgets pick: done
11. [hub] undo after archive: done
12. [hub] dark mode code blocks unreadable: done
13. [hub] search in a chat: done
14. [hub] being built groups by project: parked
15. [hub] archive button too close to delete: done
16. [hub] dock icon badge wrong: done
17. [hivra] onboarding copy too long: parked
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: waiting on you (on the Inbox card)
20. [hivra] refunds FAQ: waiting on you (on the Inbox card)
21. [hivra] hero gif 9mb: parked
22. [hivra] signup button colour: parked
23. [hivra] mobile nav overlaps logo: parked
24. [hivra] privacy page: waiting on you (on the Inbox card)
25. [hivra] stripe test mode in staging: waiting on you (on the Inbox card)
26. [hivra] dashboard takes 6s: parked
27. [nibbii] colour picker recent colours: parked
28. [nibbii] export to png cuts edges: parked
29. [nibbii] share link: parked
30. [nibbii] tutorial skips step 3 on ipad: parked
31. [nibbii] undo broken after rotate: parked
32. [nibbii] brushes sorted by most used: parked
33. [nibbii] app store screenshots out of date: parked
34. [nibbii] reply to reviewer (crash on save): done
35. [nibbii] kids mode write-up: done
36. [x] draft hub launch thread: done
37. [x] who asked about hivra last week: lost
38. [x] draft android reply: done
39. [x] what people say about monocode: lost
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes 4 open question(s) more than once (12 times in all); the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

