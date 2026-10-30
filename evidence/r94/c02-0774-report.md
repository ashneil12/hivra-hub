# Real-Claude test run

Run 20261030-181729-0774, build cos/r94 @ 4bfd4d9, 12 min wall, 14 model turns (276 model requests, 9 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| c02-team-dump Coding team: a multi-ask message with a decision in it | PARTIAL | CT, P1, P9, B5, CQ | dump: 27.2s; busy-ask: 3.2s | The coding-team orchestrator listed every ask, saved the npm-test rule, ran area-split workers, and kept Ash posted with test proof. Parallel checkouts still clobbered each other, and the last open point was left without a recommendation. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 6.046,
        "p90": 6.046,
        "max": 6.046
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
        "n": 8,
        "median": 5.072,
        "p90": 35.184,
        "max": 35.184
      },
      "waitBeforePrompt": {
        "n": 8,
        "median": 0.003,
        "p90": 0.003,
        "max": 0.003
      },
      "over20s": 2
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

### c02-team-dump: PARTIAL

- **CT** PARTIAL: The coding-team chat answered first, listed all six asks, split API/UI/docs across nested workers (distinct ports, 7 checkouts, none in Ash's room), kept talking while they ran, and reported with npm test proof. Isolation failed: the negative-bump worker deleted the health route another worker had just landed, and later jobs re-landed unrelated API and README files. Evidence: "+74s 1. The alive check (GET /health) is running. ... 3. Pointing the UI at the shared tally type is running. ... 5. The README note for the new endpoint is running. ... 6. Monday."; "+144s The worktree already had a GET /health route ... I removed it; the brief says not to add a health route."; "metrics workers.distinctPorts true, ownCheckouts 7, workersInRoom []"
- **P1** PASS: The first full reply lists asks 1–6 in order, invents none, gives one pick on the reset day, and only calls work running after those workers had started; dependent API and UI asks are explicitly waiting. Evidence: "+60s I'll add a GET /health endpoint"; "+65s I'll find the UI's local tally type"; "+69s I'll add a short README note for GET /health"; "+74s 2. Rejecting a negative bump waits on that ... 4. Last week next to this week waits on that ... Nothing is done yet."
- **P9** PASS: The 'always run npm test' rule was saved with ash_remember during the first turn, repeated in the chat and team notes, and not asked again; the README job was refused as done because it skipped npm test. Evidence: "+28s save the test rule in your words."; "memoryCalls ash_remember text: and from now on always run npm test before u say anything is done. error null"; "+98s That job skipped npm test because it only touched the README, so I'm not calling it done until a test run covers it."
- **B5** PASS: The chat said which jobs were running, answered 'hows it going' in a few seconds with what was out, and later posted short 'is back' results in the same thread while worker chatter stayed in child chats. Evidence: "+74s The alive check (GET /health) is running."; "+79s hows it going, anything need me"; "+98s Nothing needs you. ... The alive check is in. ... Rejecting a negative bump is running"; "view coding-team-after-dump: GET /health alive endpoint is back ... README documents GET /health is back"
- **CQ** PARTIAL: Replies are short, acknowledge the dump, explain why API and UI work is serialized, and give one Monday recommendation, and the lead pushes back when the health test is dropped. The close leaves the count meaning unsettled with no pick, and the transcript shows Ash the internal line about delegating before other tools. Evidence: "+74s Monday. That's the normal week start (ISO). The board job will use it."; "+90s view coding-team-thinking: I need to delegate before using any other tool."; "+717s Not settled: whether count was meant to be the all-time sum of entry.by instead of this week's sum."

Problems:
- Negative-bump worker (+144s) deleted GET /health that the health worker had already landed; later restore/last-week/type-check jobs re-landed README.md, server.ts, and server.test.ts ('and 3 more'), so checkouts are not isolated from other workers' dirty files.
- Ash-visible transcript includes the internal line 'I need to delegate before using any other tool.' (coding-team-thinking view).
- +717s leaves count as this-week vs all-time 'Not settled' with no single recommendation.
- +88s a branch-name 'Reply with JSON only / Do not call tools' prompt was concatenated into a worker brief; the worker spent the turn debating it before doing the negative-bump work.

