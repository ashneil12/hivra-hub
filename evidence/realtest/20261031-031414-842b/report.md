# Real-Claude test run

Run 20261031-031414-842b, build cos/r100 @ 2dc66bf, 32 min wall, 16 model turns (487 model requests, 6 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened | PARTIAL | B5 | dump-1: 54.9s; dump-2: 33.9s; dump-3: 8s; dump-4: 109.2s; what-happened: 180.1s | The dump survived the restart and the status answer is mostly honest, grouped, and unposted, but it is a wall of text with a waiting-count mismatch and a few items in the wrong bucket. Conversation is real and pushback is good, yet the same decision block is repeated on nearly every message. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 17.391,
        "p90": 17.391,
        "max": 17.391
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
        "median": 14.422,
        "p90": 19.639,
        "max": 19.639
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

- **B5** PARTIAL: After the reopen, all 40 asks are still accounted for in one plain count (13 done, 2 waiting, 10 blocked, 13 parked, 2 lost), nothing is called posted, the Inbox is 3 grouped decisions rather than 40 rows, and the rail has a single Needs you on Tally lead. The same reply is a wall of text, says 2 waiting while showing 3 decisions, calls the settings/badge work parked while that delegation is still running, and lists terminal font and dark code as done after saying they were not settled. Evidence: "+1885s Of 40: 13 done, 2 waiting on you, 10 blocked by your answers, 13 parked, 2 lost."; "+1548s Eleven screen changes are in, each as its own commit. Search in a chat was already there, so it was left as is."; "+1598s Not settled, so not done: terminal text is 16px, up from 13. Dark code can still be unreadable"; "+1704s inbox-after-reopen: Needs you / Tally lead · 3 decisions (not 40 rows)"; "+265s Nothing gets posted. X stays drafts and notes only."; "delegation t-b068d671 Hub settings scroll and two badges state running; t-faaa5d27 and t-6560d2c5 cancelled"
- **CQ** PARTIAL: The lead talks with Ash: it reads each dump back, says why it will not guess a project or post, and gives one recommendation (hold / view-only / ⌘N) plus a real summary when asked. Almost every turn is a long numbered list with the same Needs-the-user block pasted on again, which is the wall of text this item forbids. Evidence: "+56s Sixteen hub things, in your order. None of this is Tally, so it stays off the Tally board."; "+173s Needs the user: Which project is the onboarding, price page, and dashboard? / My pick: Hold them. Don't guess a name."; "+1885s Of 40: 13 done, 2 waiting on you, 10 blocked by your answers, 13 parked, 2 lost."; "+1605s It's at the bottom of the window: Now or Preview, then Apply or Discard. You click. / Needs the user: Which project is the onboarding..."

Problems:
- +1885s status is a full inventory wall, not the short plain count the check asks for.
- Same message says '2 waiting on you' and then '3 decisions are on your Inbox card'.
- Settings scroll, dock badge, and rail badge are called parked while delegation t-b068d671 is still running.
- Launch thread, Android reply, and reviewer reply are described as 'draft only, not sent/posted' even though those delegations were cancelled.
- Terminal font and dark code are listed Done after +1598s said 'Not settled, so not done'.
- The same two Needs-the-user questions are appended to almost every tally-lead message.

Asks Ash sent: 40; missing from the status answer: 1.

1. [hub] inbox rows too tall: done
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: waiting on you (on the Inbox card)
4. [hub] terminal font tiny: done
5. [hub] notes sync between windows: done
6. [hub] pin a chat to the top: done
7. [hub] rail badge doesn't clear: parked
8. [hub] today shows finished overnight: MISSING
9. [hub] send button jumps: done
10. [hub] model picker forgets pick: done
11. [hub] undo after archive: done
12. [hub] dark mode code blocks unreadable: done
13. [hub] search in a chat: done
14. [hub] being built groups by project: done
15. [hub] archive button too close to delete: done
16. [hub] dock icon badge wrong: parked
17. [hivra] onboarding copy too long: blocked by your answers
18. [hivra] price page says beta: blocked by your answers
19. [hivra] waitlist emails to spam / DKIM: blocked by your answers
20. [hivra] refunds FAQ: blocked by your answers
21. [hivra] hero gif 9mb: blocked by your answers
22. [hivra] signup button colour: blocked by your answers
23. [hivra] mobile nav overlaps logo: blocked by your answers
24. [hivra] privacy page: blocked by your answers
25. [hivra] stripe test mode in staging: blocked by your answers
26. [hivra] dashboard takes 6s: blocked by your answers
27. [nibbii] colour picker recent colours: parked
28. [nibbii] export to png cuts edges: parked
29. [nibbii] share link: waiting on you (on the Inbox card)
30. [nibbii] tutorial skips step 3 on ipad: parked
31. [nibbii] undo broken after rotate: parked
32. [nibbii] brushes sorted by most used: parked
33. [nibbii] app store screenshots out of date: parked
34. [nibbii] reply to reviewer (crash on save): parked
35. [nibbii] kids mode write-up: parked
36. [x] draft hub launch thread: parked
37. [x] who asked about hivra last week: lost
38. [x] draft android reply: parked
39. [x] what people say about monocode: lost
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes 3 open question(s) more than once (18 times in all); the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

