# Real-Claude test run

Run 20261031-084825-d241, build cos/r101 @ d8ac3b8, 37 min wall, 14 model turns (553 model requests, 7 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 40.2s; dump-2: 19.5s; dump-3: 166.6s; dump-4: 150.7s; what-happened: 68.8s | The dump survived the restart: the status line adds up to 40, done items are backed by the worker report or text already in the thread, and the inbox shows two grouped Needs you cards. Conversation quality is only partial because one update is a wall of text and the lead is silent for roughly 18 minutes mid-build. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 8.049,
        "p90": 8.049,
        "max": 8.049
      },
      "waitBeforePrompt": {
        "n": 2,
        "median": 0.004,
        "p90": 0.004,
        "max": 0.004
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 5,
        "median": 12.781,
        "p90": 21.907,
        "max": 21.907
      },
      "waitBeforePrompt": {
        "n": 5,
        "median": 0.002,
        "p90": 0.003,
        "max": 0.003
      },
      "over20s": 1
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

- **B5** PASS: After the reopen every one of the 40 asks is still accounted for in the same thread (13 done, 3 blocked by Ash, 24 parked; running correctly omitted), the done hub items match the worker report, nothing is called posted, and the inbox/rail group the real asks instead of 40 rows. Evidence: "+2224s Of 40: 13 done, 3 blocked by your answers, 24 parked."; "+1938s Inbox rows are shorter (`704f3f40`). ... Today leads with what finished overnight (`ddd94207`)."; "+316s Draft thread, not posted: ... Pin idea: one line on the profile"; "+2155s inbox-after-reopen: Needs you Tally lead (which shortcut) and Chief of Staff · 2 decisions; not 40 raw rows."; "+2241s rail-after-answer: Needs you only on Chief of Staff and Tally lead."
- **CQ** PARTIAL: The lead does talk with Ash: it restates the dump, says what it is starting and why, gives one recommendation (⌘N), and pushes back on posting, DNS, Stripe, and guessing Android. The +316s update is still a wall of text, and the lead then goes quiet for about 18 minutes while the worker keeps going. Evidence: "+41s Sixteen things, in your order. I’m capturing them as you said them... Needs the user: which shortcut for a new chat? My pick: ⌘N."; "+316s Your four dumps, in order: [full 40-item list plus kids-mode writeup plus draft thread]"; "+399s The hub fixes are still being built in a preview and are not in the app yet. [next lead line is +1507s]"

Problems:
- +316s tally-lead message is a wall: the full 40-item restatement, a kids-mode essay, and a four-part draft in one reply.
- Lead silent from +399s to +1507s (~18 min) while the hub worker was still working (+960s, +1436s).
- +378s lead told Ash Chief of Staff said no to DNS and Stripe, but those were still open buttons and were asked again after restart (+2137s).

Asks Ash sent: 40; missing from the status answer: 0.

1. [hub] inbox rows too tall: done
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: blocked by your answers
4. [hub] terminal font tiny: done
5. [hub] notes sync between windows: parked
6. [hub] pin a chat to the top: done
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: done
9. [hub] send button jumps: done
10. [hub] model picker forgets pick: done
11. [hub] undo after archive: done
12. [hub] dark mode code blocks unreadable: done
13. [hub] search in a chat: done
14. [hub] being built groups by project: parked
15. [hub] archive button too close to delete: done
16. [hub] dock icon badge wrong: parked
17. [hivra] onboarding copy too long: parked
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: blocked by your answers
20. [hivra] refunds FAQ: parked
21. [hivra] hero gif 9mb: parked
22. [hivra] signup button colour: parked
23. [hivra] mobile nav overlaps logo: parked
24. [hivra] privacy page: parked
25. [hivra] stripe test mode in staging: blocked by your answers
26. [hivra] dashboard takes 6s: parked
27. [nibbii] colour picker recent colours: parked
28. [nibbii] export to png cuts edges: parked
29. [nibbii] share link: parked
30. [nibbii] tutorial skips step 3 on ipad: parked
31. [nibbii] undo broken after rotate: parked
32. [nibbii] brushes sorted by most used: parked
33. [nibbii] app store screenshots out of date: parked
34. [nibbii] reply to reviewer (crash on save): parked
35. [nibbii] kids mode write-up: done
36. [x] draft hub launch thread: done
37. [x] who asked about hivra last week: parked
38. [x] draft android reply: parked
39. [x] what people say about monocode: parked
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes each open question once; the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

