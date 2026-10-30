# Real-Claude test run

Run 20261030-200502-242d, build cos/r96 @ 6d91982, 7 min wall, 14 model turns (191 model requests, 7 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| c02-team-dump Coding team: a multi-ask message with a decision in it | PASS | CT, P1, P9, B5, CQ | dump: 23.1s; busy-ask: 2.8s | The coding-team chat listed every ask, split the work across isolated workers, saved the npm-test rule, kept Ash posted, and reported concrete results with one recommendation. Nothing in the five items failed; the nits are sequencing, one stale status line, and an unrequested median fix. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 5.677,
        "p90": 5.677,
        "max": 5.677
      },
      "waitBeforePrompt": {
        "n": 1,
        "median": 0.003,
        "p90": 0.003,
        "max": 0.003
      },
      "over20s": 0
    },
    "other": {
      "total": {
        "n": 6,
        "median": 1.995,
        "p90": 38.677,
        "max": 38.677
      },
      "waitBeforePrompt": {
        "n": 6,
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

### c02-team-dump: PASS

- **CT** PASS: The new coding-team chat orchestrated: it answered first, listed all six asks, split API / UI / README (then the board) into nested workers with distinct ports and checkouts, kept talking while they ran, saved the npm-test rule, and closed with a plain proofed rollup. Workers never posted to Ash. Evidence: "+23s Six asks. I'll load the delegate and memory tools first, then hand each area off with Monday as the week start."; "+73s 1. A live `GET /health` is in progress with the negative-bump check. / 2. A negative bump will come back as a plain-English error, same job. / 3. The UI tally type is moving onto the shared package. / 4. Last week's total next to this week is waiting on that UI change"; "+387s `GET /health` returns plain text `alive` ... `npm test`: 16 passed, 0 failed."; "metrics workers.distinctPorts true, ownCheckouts 5, workersInRoom []"
- **P1** PASS: One opening-turn reply numbered all six asks, invented none, and did not claim the deferred board job had started. Independent API, UI, and README work was already running in parallel; the only discussion point got a single pick (Monday). The full list is the third bubble (~73s), which is only a timing note. Evidence: "+66s I'll add GET /health and a plain-English rejection for negative bumps"; "+68s I'll find the UI's local tally type and switch it to the shared package"; "+71s I'll document GET /health in the README only"; "+73s 6. Monday. That is the normal week start (ISO / a work week), and the board will use it."
- **P9** PASS: The 'from now on always run npm test' line was written with ash_remember during the opening turn, then shown back in Ash's words, and never asked again; later 'done' claims were withheld while the suite was red. Evidence: "+81s - from now on always run npm test before u say anything is done."; "+94s Right: that rule is already in Tally memory, in Ash's words."; "memoryCalls ash_remember text: and from now on always run npm test before u say anything is done. error null"
- **B5** PASS: The chat said the parallel jobs were running, answered Ash in that same thread while they ran, and later posted short results there. Worker self-reviews stayed in child chats (empty workersInRoom; 5 sub-chats). Evidence: "+73s A live `GET /health` is in progress ... The README note for `GET /health` is in progress."; "+86s Nothing needed from you. Three jobs are still working: the health check and the negative-bump error, the shared tally type, and the README note."; "+387s The board shows last week's total beside this week, with weeks starting Monday."
- **CQ** PASS: Replies acknowledge Ash, say what is moving and why, stay short, and end on one open point with a single recommendation instead of silent work or a wall of text. Evidence: "+86s Nothing needed from you. Three jobs are still working"; "+387s Needs Ash: keep that all-time order, or sort by this week? My pick is to keep the all-time order."

Problems:
- Ask 4 (last week's total) was held until +171s behind the shared-type job instead of starting with the API/UI/README workers at +66–71s.
- +338s parent status still said health/negative-bump was running and that the README health line had no route, just after the API worker finished the route at +336s.
- Orchestrator dispatched an unrequested even-count median fix (+340s) so npm test would go green; workers had called that starter failure intentional.

