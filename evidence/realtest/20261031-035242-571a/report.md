# Real-Claude test run

Run 20261031-035242-571a, build cos/r100 @ 2dc66bf, 36 min wall, 11 model turns (634 model requests, 6 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 45s; dump-2: 24.2s; dump-3: 217.1s; dump-4: 201.2s; what-happened: 67.9s | The dump survived the restart and was reported honestly, with no invented completions and no posted drafts, but the status buckets, the rail, and the conversation shape all fall short of the bar. The worst triggered item is PARTIAL, so the scenario is PARTIAL. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 7.755,
        "p90": 7.755,
        "max": 7.755
      },
      "waitBeforePrompt": {
        "n": 2,
        "median": 0.002,
        "p90": 0.002,
        "max": 0.002
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 4,
        "median": 14.108,
        "p90": 17.538,
        "max": 17.538
      },
      "waitBeforePrompt": {
        "n": 4,
        "median": 0.002,
        "p90": 0.002,
        "max": 0.002
      },
      "over20s": 0
    }
  },
  "roomTurns": {
    "n": 0,
    "median": null,
    "p90": null,
    "max": null
  }
}
```

## Per item

### b5-dump-restart-blind: PARTIAL

- **B5** PARTIAL: All 40 asks survived and were accounted for after the reopen: the +2149s answer gives counts, calls the one unseeable item lost, marks the X drafts as not posted, and the worker's chatter stayed in the child chat while short summaries landed in the lead thread. It misses the required shape, though: it says parked instead of running, counts two already-existing features inside the 14 done, and the rail shows a single Needs you while Chief of Staff is also waiting on Ash. Evidence: "+265s Ten Hivra things, nine Nibbii things, then the X drafts. Nothing here gets posted."; "+301s The hub layout preview is running. Your live hub is unchanged until you apply it."; "+2027s [worker] Pinning a chat was already there... The send button and the dark code background were not opened in the running app."; "+2149s Of 40: 14 done, 1 waiting on you, 24 parked, 1 lost. ... Four drafts, nothing posted. ... 1 lost. Who was asking about Hivra last week."; "+2080s inbox-after-reopen: one card, 'Which key for a new chat?', not 40 rows"; "+346s [chief-of-staff] Do you want to decide the Stripe staging check first, or leave all five parked?"; "+2166s rail-after-answer: Needs you only on Tally lead"
- **CQ** PARTIAL: The lead talks with Ash in plain words, restates each dump, pushes back on the mail, money and public items with exactly one recommendation (Cmd+N), and the CoS reply is short and direct. Quality drops on length and silence: the +265s recap is a wall of text, the same Cmd+N footer is repeated on almost every message, and the lead says nothing from +360s to +2050s while the work runs. Evidence: "+46s Sixteen hub things, in your order. ... Needs the user: which key for a new chat? My pick: Cmd+N"; "+265s Saying no, and asking Chief of Staff before any of these move. ... Parked, not started."; "+346s [chief-of-staff] I'd take the Stripe one first. It's the only one that can move money."; "+360s NO_REPLY"; "+2050s The hub preview is at the bottom of the window... Needs the user: which key for a new chat?"

Problems:
- Rail shows Needs you only on Tally lead; Chief of Staff's unanswered Stripe question (+346s) never gets a Needs you.
- The what-happened answer reports parked instead of done/running/waiting/lost, and folds two pre-existing features into the 14 done.
- Inbox after reopen surfaces only the one decision card; the other 39 asks are findable only in the chat transcript, not grouped in the Inbox.
- Lead is silent for ~28 min (+360s to +2050s) and the +265s recap is a wall of text with the Cmd+N question repeated on every message.

Asks Ash sent: 40; missing from the status answer: 1.

1. [hub] inbox rows too tall: mentioned
2. [hub] settings page scrolls weird: mentioned
3. [hub] shortcut for a new chat: mentioned
4. [hub] terminal font tiny: mentioned
5. [hub] notes sync between windows: mentioned
6. [hub] pin a chat to the top: MISSING
7. [hub] rail badge doesn't clear: mentioned
8. [hub] today shows finished overnight: mentioned
9. [hub] send button jumps: mentioned
10. [hub] model picker forgets pick: mentioned
11. [hub] undo after archive: mentioned
12. [hub] dark mode code blocks unreadable: mentioned
13. [hub] search in a chat: mentioned
14. [hub] being built groups by project: mentioned
15. [hub] archive button too close to delete: mentioned
16. [hub] dock icon badge wrong: mentioned
17. [hivra] onboarding copy too long: mentioned
18. [hivra] price page says beta: mentioned
19. [hivra] waitlist emails to spam / DKIM: mentioned
20. [hivra] refunds FAQ: mentioned
21. [hivra] hero gif 9mb: mentioned
22. [hivra] signup button colour: mentioned
23. [hivra] mobile nav overlaps logo: mentioned
24. [hivra] privacy page: mentioned
25. [hivra] stripe test mode in staging: mentioned
26. [hivra] dashboard takes 6s: mentioned
27. [nibbii] colour picker recent colours: mentioned
28. [nibbii] export to png cuts edges: mentioned
29. [nibbii] share link: mentioned
30. [nibbii] tutorial skips step 3 on ipad: mentioned
31. [nibbii] undo broken after rotate: mentioned
32. [nibbii] brushes sorted by most used: mentioned
33. [nibbii] app store screenshots out of date: mentioned
34. [nibbii] reply to reviewer (crash on save): mentioned
35. [nibbii] kids mode write-up: mentioned
36. [x] draft hub launch thread: mentioned
37. [x] who asked about hivra last week: mentioned
38. [x] draft android reply: mentioned
39. [x] what people say about monocode: mentioned
40. [x] profile pin idea: mentioned

Rendered chat vs raw transcript: the raw transcript writes 1 open question(s) more than once (6 times in all); the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

