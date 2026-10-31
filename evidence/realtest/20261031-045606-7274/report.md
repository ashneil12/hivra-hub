# Real-Claude test run

Run 20261031-045606-7274, build cos/r101 @ d8ac3b8, 42 min wall, 16 model turns (897 model requests, 7 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 59.2s; dump-2: 38.6s; dump-3: 12.9s; dump-4: 60.7s | The restart half of this blind dump never ran, so B5 cannot be scored. Conversation quality is only partial: the lead acknowledged, pushed back, and recommended once, but in long lists, with a contradictory re-file of five Hivra lines and a long silent stretch while work continued. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 3,
        "median": 11.061,
        "p90": 12.043,
        "max": 12.043
      },
      "waitBeforePrompt": {
        "n": 3,
        "median": 0.002,
        "p90": 0.002,
        "max": 0.002
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 4,
        "median": 14.585,
        "p90": 16.624,
        "max": 16.624
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

- **B5** NOT-TRIGGERED: The blind restart never happened, so survival of the 40 asks, a done/running/waiting/blocked/parked answer, inbox grouping, and the rail cannot be judged. The app refused Quit because a chat was still running, and Ash never asked what happened to the dump. Evidence: "harness: restart: the app didn't take the quit: 1 chat(s) still running; Quit would ask in a Mac dialog"; "+63s Ash -> tally-lead: thats it for now, do whatever u can and park the rest, ill be back later"; "+2351s [worker of tally-lead chat] Search, the new-chat shortcut, the model pick, the rail badge, and archive undo are still open."
- **CQ** PARTIAL: The lead did talk with Ash: it restated the dumps, said why (Apply/Discard, nothing posted, no invented refund or Android answer), and gave one recommendation on the open calls. The replies are walls of numbered lists, the same five lines are re-explained and then mis-filed as Nibbii, and after +1143s the hub worker keeps going for ~20 minutes with no further word to Ash. Evidence: "+60s [tally-lead chat] Sixteen hub things, in your order. ... One call I am making without asking: new-chat shortcut is ⌘N."; "+124s [tally-lead chat] My pick: no FAQ until you say the rule. I won't invent a money policy. ... My pick: no. That's a public reply, so I won't send it."; "+202s [tally-lead chat] The Android reply waits on whether Nibbii actually runs on Android. I won't draft a yes or a no I don't know."; "+536s [tally-lead chat] Hivra and Nibbii never got their briefs ... Nothing was posted. ... My pick: reopen both."; "+577s [tally-lead chat] Fixed: those five were in the Nibbii brief that never landed"; "+1143s [tally-lead chat] NO_REPLY"

Problems:
- Quit never fired: one chat still running, so Quit would raise a Mac dialog and the reopen plus 'wat happened' never occurred.
- +141s room router dropped the five X asks ('The reply never picks up the five concrete asks') before the lead recovered them at +202s.
- The same five lines are 'only listed, never filed' (+226s), 'never handed off' (+465s), then called a Nibbii brief (+577s) after being named as Hivra (onboarding, beta, DKIM, refund FAQ, hero gif).
- Lead replies are walls (16- and 19-item restatements at +60s and +124s; long +536s status) and later turns are marked '(2 asks it asked before left out)' / '(3 asks it asked before left out)'.
- After +1143s the lead is silent while the hub worker is still committing through +2351s; only one delegation ('Hub dump from Ash') stays running, with no closing summary.

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

