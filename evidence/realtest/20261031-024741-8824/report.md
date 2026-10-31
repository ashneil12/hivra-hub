# Real-Claude test run

Run 20261031-024741-8824, build cos/r100 @ f58012c, 10 min wall, 8 model turns (35 model requests, 5 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 72.9s; dump-2: 52s; dump-3: 26.2s; dump-4: 10.5s; what-happened: 57.4s | The dump survived the restart and the answer is an honest, grouped, plain accounting that posts nothing, but one of the five items called done rests on an unverified lookup. Conversation quality is good: the lead acknowledges, explains, pushes back and gives one recommendation per decision. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 2.661,
        "p90": 2.661,
        "max": 2.661
      },
      "waitBeforePrompt": {
        "n": 1,
        "median": 0.002,
        "p90": 0.002,
        "max": 0.002
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 4,
        "median": 12.741,
        "p90": 13.359,
        "max": 13.359
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

- **B5** PARTIAL: After the reopen the lead accounts for all 40 asks (5 done, 5 waiting, 1 lost, 29 parked), posts nothing to X, groups the 5 decisions into one Inbox card and shows a single rail 'Needs you'. But it marks the MonoCode lookup Done with no worker report or proof after its own search tool failed, and it never states a 'running' count. Evidence: "+576s Of 40: 5 done, 5 waiting on you, 1 lost, 29 parked. 5 decisions are on your Inbox card."; "+318s Search failed on the tool. Trying a direct lookup."; "+396s Fixed: checked this week and found no readable X, Reddit, or HN talk about MonoCode (X and Reddit blocked...)"; "+576s Lost. Who was asking about Hivra last week. The lookup failed, so there is no list."; "inbox-after-reopen: 'Needs you / Tally lead · 5 decisions' (one card, not 40 rows); rail shows one 'Needs you'"
- **CQ** PASS: The lead talks with Ash rather than working silently: it acknowledges each dump, explains what it is doing and why, pushes back on mail, Stripe, posting and publishing, and gives exactly one recommendation per open decision, led by a one-line summary. Evidence: "+74s Got all 16, in your order. ... Needs the user: which shortcut for a new chat? My pick: Cmd+N, if nothing else already owns it."; "+249s No on the red ones. I won't touch them."; "+576s Of 40: 5 done, 5 waiting on you, 1 lost, 29 parked."

Problems:
- MonoCode 'this week' check is called Done (+576s) even though the search 'failed on the tool' (+318s) and there is no worker, delegation or captured lookup result (delegations 0, workers 0); do not count it done without proof.
- The status line gives done/waiting/lost/parked but never an explicit 'running' count, so the required done/running/waiting/lost breakdown is incomplete.
- At +74s the lead said it was 'Starting now' on the 15 hub fixes, which it later admits never started; avoid claiming work has started before it has.

Asks Ash sent: 40; missing from the status answer: 1.

1. [hub] inbox rows too tall: parked
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: waiting on you (on the Inbox card)
4. [hub] terminal font tiny: parked
5. [hub] notes sync between windows: parked
6. [hub] pin a chat to the top: parked
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: parked
9. [hub] send button jumps: parked
10. [hub] model picker forgets pick: parked
11. [hub] undo after archive: parked
12. [hub] dark mode code blocks unreadable: parked
13. [hub] search in a chat: parked
14. [hub] being built groups by project: parked
15. [hub] archive button too close to delete: MISSING
16. [hub] dock icon badge wrong: parked
17. [hivra] onboarding copy too long: parked
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: waiting on you (on the Inbox card)
20. [hivra] refunds FAQ: parked
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
34. [nibbii] reply to reviewer (crash on save): waiting on you (on the Inbox card)
35. [nibbii] kids mode write-up: done
36. [x] draft hub launch thread: done
37. [x] who asked about hivra last week: lost
38. [x] draft android reply: done
39. [x] what people say about monocode: done
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes 5 open question(s) more than once (11 times in all); the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

