# Real-Claude test run

Run 20261031-081829-05bc, build cos/r101 @ d8ac3b8, 25 min wall, 13 model turns (402 model requests, 6 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 33.6s; dump-2: 12.9s; dump-3: 51.3s; dump-4: 35.5s; what-happened: 84.6s | The dump survived the restart and the lead’s status is mostly honest and findable, but the headline counts disagree with the bullets and the reply is far too long. Conversation is real and has useful pushback, yet it repeats the dump and then goes silent for about fourteen minutes. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 19.292,
        "p90": 19.292,
        "max": 19.292
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
        "median": 16.765,
        "p90": 16.863,
        "max": 16.863
      },
      "waitBeforePrompt": {
        "n": 4,
        "median": 0.002,
        "p90": 0.003,
        "max": 0.003
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

- **B5** PARTIAL: All 40 asks survived the reopen and the +1473s reply accounts for every one, with drafts marked not posted and no item called done without a report. The count line does not match its own list (11 done / 27 parked vs 10 done bullets and 28 parked bullets), the reply is long, and Chief of Staff’s open privacy decision is not a rail Needs you. Evidence: "+1473s Of 40: 11 done, 1 already there, 1 blocked by your answer, 27 parked."; "+1473s The hub launch thread is drafted, not posted. ... The reply to the reviewer who said it crashes on save is drafted, not sent."; "+1387s Inbox: Nothing new here since then. Needs you — Which shortcut for a new chat? Suggests: Cmd+N."; "+1491s rail: Tally lead Needs you only; Chief of Staff has no Needs you"
- **CQ** PARTIAL: The lead talks with Ash, explains why red-line items wait, pushes back instead of inventing an Android answer, and gives one shortcut pick (Cmd+N). Several replies restate the whole dump and the status answer is a wall, and the lead thread goes quiet from +412s to +1256s while the worker runs. Evidence: "+34s Needs the user: which shortcut for a new chat? / My pick: Cmd+N."; "+296s Parked, I won't invent it: a yes or no on Nibbii for Android. I don't know which it is, so there is no draft."; "+412s Still your call on the privacy page: have Tally draft it for you to OK, or leave all three parked."; "+1473s Of 40: 11 done... (full bucket-by-bucket restatement of all 40 asks)"

Problems:
- +1473s count line says 11 done and 27 parked, but the same message lists 10 Done bullets and 28 Parked bullets; derive the Of-40 line from those buckets.
- Rail and Inbox after reopen show only Tally lead Needs you; Chief of Staff’s still-open privacy-page question (+412s) has no Needs you.
- What-happened reply is a long multi-section inventory, not the short plain status the check asks for.
- Lead restates all 16 then all 10 asks verbatim (+34s, +99s, +296s) instead of a short ack plus the plan.
- Lead thread is silent from +412s until +1256s while the hub worker runs; post a one-line still-working update in the parent chat.

Asks Ash sent: 40; missing from the status answer: 0.

1. [hub] inbox rows too tall: parked
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: blocked by your answers
4. [hub] terminal font tiny: done
5. [hub] notes sync between windows: done
6. [hub] pin a chat to the top: done
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: parked
9. [hub] send button jumps: done
10. [hub] model picker forgets pick: parked
11. [hub] undo after archive: done
12. [hub] dark mode code blocks unreadable: parked
13. [hub] search in a chat: done
14. [hub] being built groups by project: parked
15. [hub] archive button too close to delete: done
16. [hub] dock icon badge wrong: parked
17. [hivra] onboarding copy too long: parked
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: parked
20. [hivra] refunds FAQ: parked
21. [hivra] hero gif 9mb: parked
22. [hivra] signup button colour: parked
23. [hivra] mobile nav overlaps logo: parked
24. [hivra] privacy page: parked
25. [hivra] stripe test mode in staging: parked
26. [hivra] dashboard takes 6s: done
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
37. [x] who asked about hivra last week: parked
38. [x] draft android reply: parked
39. [x] what people say about monocode: parked
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes each open question once; the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

