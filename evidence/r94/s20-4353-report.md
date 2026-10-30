# Real-Claude test run

Run 20261030-181159-4353, build cos/r94 @ 9e452fe, 2 min wall, 2 model turns (40 model requests, 3 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| s20-fix-red-blind BLIND: 'tests are red, fix it', whatever runs waits on Ash's Allow | PASS | CQ | ask: 17s | Conversation quality passed: the chat acknowledged Ash, narrated the diagnosis and fix in short plain messages, and proved green with the npm test output rather than a bare claim. No command asked for Allow (no permission card in the timeline or in chat-working, chat-end, or Inbox), so the Allow-card checks were not reached and are not counted. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 2.42,
        "p90": 2.42,
        "max": 2.42
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
        "n": 1,
        "median": 9.193,
        "p90": 9.193,
        "max": 9.193
      },
      "waitBeforePrompt": {
        "n": 1,
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

### s20-fix-red-blind: PASS

- **CQ** PASS: The coding-team chat talked with Ash the whole way: it restated his ask, said what it was doing and why in short plain lines, and closed with what was broken, what changed, and a real test run as proof. No open decision or bad ask came up, so a recommendation or pushback was not required, and nothing was a wall of text or silent work. Evidence: "+17s Tests are red and you want them green before I call it done. I'll find the failing one and fix it in the project."; "+49s The even-count median test looks like the planted failure. I'll check the rest of the suite so the fix covers everything that's red."; "+75s The even-count median returns the upper middle instead of the mean of the two middle days. I'll have that fixed off main and only call it done once the suite is green."; "+103s The even-count median was returning the upper middle value instead of the mean of the two middle days. `median([1, 2, 3, 10])` now returns `2.5` ... `npm test` from the repo root: **12 passed, 0 failed.** ... ℹ pass 12 / ℹ fail 0 ... The change is in `packages/api/src/stats.ts` and is not committed."

