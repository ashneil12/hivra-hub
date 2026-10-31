# Real-Claude test run

Run 20261031-015940-9882, build cos/r100 @ 43c120b, 36 min wall, 9 model turns (620 model requests, 6 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 20.7s; dump-2: 29.2s; dump-3: 3.6s; dump-4: 380.3s; what-happened: 47.9s | The dump survived the restart and the what-happened reply did not invent finished work, posted nothing, and the Inbox stayed one grouped Needs you card. Both items miss the bar on length and on a single recommendation, so the scenario is partial. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 7.232,
        "p90": 7.232,
        "max": 7.232
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
        "median": 13.972,
        "p90": 14.01,
        "max": 14.01
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

- **B5** PARTIAL: All 40 asks survived the reopen and the reply counted them honestly (13 done only where a draft or the worker report existed, nothing posted, inbox is one 4-decision card, one Needs you on Tally). It is not the short plain status asked for: no running figure, two earlier-parked X lookups are called lost, and the same four decisions are pasted again as a long recap. Evidence: "+444s Forty things, in the order you said them. Nothing here is posted."; "+639s The hub rough edges are in a preview."; "+1960s Ten screen changes are in. Five parts of the ask are not"; "+2101s Of 40: 13 done, 4 waiting on you, 21 parked, 2 lost."; "+2101s Drafts only, nothing posted or sent"; "inbox-after-reopen: Tally lead · 4 decisions (not 40 rows); rail: Tally lead Needs you once"
- **CQ** PARTIAL: The lead did talk with Ash: it acknowledged each dump, said what it would start and why, pushed back on the red lines, and led the later answer with a count. The thread is not short or one recommendation: the +444s inventory is a wall, the four questions are repeated at +680s, +2011s and +2101s, and Chief of Staff's Stripe pick contradicts Tally's. Evidence: "+22s Sixteen hub things, in your order. I’ll capture them as you said them, then start the ones that don’t need a call from you."; "+489s I'd start with the Stripe check: look and report only, no key change."; "+680s My pick: No. Don't open Stripe or the staging billing settings."; "+2101s Needs the user: May someone check whether Hivra staging is still in Stripe test mode?"

Problems:
- +2101s status is a long recap that reprints the four Inbox decisions instead of a short done/running/waiting/lost line with no extra prompts.
- Running is never stated; the two X lookups move from parked (+639s) to lost (+2101s) without new information.
- +639s says the hub preview is already in while the worker is still editing until +1960s.
- Chief of Staff recommends a Stripe look-and-report (+489s) while Tally's pick is No, don't open Stripe (+680s and +2101s).
- ash_remember stored only 'Ash's 31 Oct dump was hub, Hivra, Nibbii, and X drafts', not the 40 asks.

Asks Ash sent: 40; missing from the status answer: 6.

1. [hub] inbox rows too tall: parked
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: parked
4. [hub] terminal font tiny: done
5. [hub] notes sync between windows: done
6. [hub] pin a chat to the top: parked
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: parked
9. [hub] send button jumps: parked
10. [hub] model picker forgets pick: MISSING
11. [hub] undo after archive: done
12. [hub] dark mode code blocks unreadable: done
13. [hub] search in a chat: done
14. [hub] being built groups by project: parked
15. [hub] archive button too close to delete: MISSING
16. [hub] dock icon badge wrong: done
17. [hivra] onboarding copy too long: parked
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: MISSING
20. [hivra] refunds FAQ: MISSING
21. [hivra] hero gif 9mb: parked
22. [hivra] signup button colour: parked
23. [hivra] mobile nav overlaps logo: parked
24. [hivra] privacy page: MISSING
25. [hivra] stripe test mode in staging: MISSING
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

