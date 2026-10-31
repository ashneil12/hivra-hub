# Real-Claude test run

Run 20261031-074309-ad89, build cos/r101 @ d8ac3b8, 28 min wall, 12 model turns (479 model requests, 6 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| b5-dump-restart-partial-blind BLIND: Ash dumps about 40 asks into the Lead, quits the app, opens it again and asks what happened (one row of a multi-row card answered) | PARTIAL | B5 | dump-1: 40.1s; dump-2: 19.3s; dump-3: 51.3s; dump-4: 35.5s; what-happened: 36.7s | After the reopen the lead still accounts for all 40 asks honestly and the Inbox is grouped, but the four decisions Ash was meant to answer one-by-one are a single Take-the-pick card, so the blind one-row path never ran. Conversation is real and has a recommendation and pushback, but the status replies are too long. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 2,
        "median": 12.146,
        "p90": 12.146,
        "max": 12.146
      },
      "waitBeforePrompt": {
        "n": 2,
        "median": 0.003,
        "p90": 0.003,
        "max": 0.003
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 4,
        "median": 16.402,
        "p90": 17.362,
        "max": 17.362
      },
      "waitBeforePrompt": {
        "n": 4,
        "median": 0.003,
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

### b5-dump-restart-partial-blind: PARTIAL

- **B5** PARTIAL: The restart answer keeps all 40 asks, omits the empty running bucket, and does not call the X drafts posted or the thrown-away hub preview done, and the Inbox is two grouped Needs-you cards rather than 40 rows. The blind step failed: those four decisions are one blob, not a multi-row card, so one row could not be answered, the other rows never stayed as rows, and the lead never acted on a single pick. Evidence: "+1679s Of 40: 4 done, 4 blocked by your answers, 32 parked."; "+1679s the hub-launch thread (not posted), the Android reply (not sent"; "+1634s Ash answered from Today (Take the pick): not possible: no row 0 on a multi-row card (0 rows)"; "+1633s Needs you / Tally lead / New-chat shortcut, terminal font size, whether notes sync is the notes panel on the same chat, and whether pin is one chat or several. / Take the pick"
- **CQ** PARTIAL: The lead acknowledges each dump, says why it will not build Hivra or Nibbii in Tally, pushes back on the red items, and gives one pick, and worker chatter stays in the child chat. The +338s recap is a wall of lists plus a model-status line, and later statuses repeat the same hold instead of staying short. Evidence: "+41s My pick: Cmd+N, match the chat font, sync the notes panel across windows of the same chat, several pins kept above the list."; "+98s No on the red ones, until Chief of Staff says otherwise."; "+338s Of 40: 4 done, 12 running, 4 waiting on you, 20 parked. ... Grok 4.7 · High · DeepSeek wasn't available"

Problems:
- Inbox card for the four hub decisions is one Take-the-pick blob, so +1634s failed with no row 0 on a multi-row card (0 rows) and inbox-after-one-row did not change.
- Lead never applied one answered row or updated a remaining-rows count, because that answer could not be sent.
- +338s is a wall of numbered lists and ends with 'Grok 4.7 · High · DeepSeek wasn't available'.
- Lead chat shows work-item id hc-mvw3m10bqcva.
- +338s called twelve hub fixes in a preview and running before the worker report at +1543s; +1603s then threw the preview away and the hub-lead handoff did not reach them.

Asks Ash sent: 40; missing from the status answer: 23.

1. [hub] inbox rows too tall: MISSING
2. [hub] settings page scrolls weird: parked
3. [hub] shortcut for a new chat: blocked by your answers
4. [hub] terminal font tiny: blocked by your answers
5. [hub] notes sync between windows: blocked by your answers
6. [hub] pin a chat to the top: blocked by your answers
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
18. [hivra] price page says beta: parked
19. [hivra] waitlist emails to spam / DKIM: parked
20. [hivra] refunds FAQ: parked
21. [hivra] hero gif 9mb: MISSING
22. [hivra] signup button colour: MISSING
23. [hivra] mobile nav overlaps logo: MISSING
24. [hivra] privacy page: parked
25. [hivra] stripe test mode in staging: parked
26. [hivra] dashboard takes 6s: MISSING
27. [nibbii] colour picker recent colours: MISSING
28. [nibbii] export to png cuts edges: MISSING
29. [nibbii] share link: MISSING
30. [nibbii] tutorial skips step 3 on ipad: MISSING
31. [nibbii] undo broken after rotate: MISSING
32. [nibbii] brushes sorted by most used: MISSING
33. [nibbii] app store screenshots out of date: MISSING
34. [nibbii] reply to reviewer (crash on save): parked
35. [nibbii] kids mode write-up: done
36. [x] draft hub launch thread: done
37. [x] who asked about hivra last week: parked
38. [x] draft android reply: done
39. [x] what people say about monocode: parked
40. [x] profile pin idea: done

Rendered chat vs raw transcript: the raw transcript writes each open question once; the rendered chat shows 0 marker line(s) and each open ask once (repeats are left out where it renders, askMarkers.ts). Repeats counted only from the transcript are transcript-only, not what Ash reads.

