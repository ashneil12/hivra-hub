# Real-Claude test run

Run 20261030-183531-8c60, build cos/r94 @ 20649a8, 5 min wall, 6 model turns (51 model requests, 4 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| s15-provider-stall-scripted SCRIPTED: a worker's provider errors and goes quiet | PASS | B12, P3 | ask: 10.1s | The scripted 529 stall was surfaced in plain words on the Lead chat, the Mono rail, Being built and Today as soon as the flag was set, with the worker's chat one click away, and the Lead retried on its own, stopped the duplicate, and reported the finished job once the call went through. The flag was gone afterward and the Lead never pretended the stalled job was fine. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 3.678,
        "p90": 3.678,
        "max": 3.678
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
        "n": 3,
        "median": 1.843,
        "p90": 9.167,
        "max": 9.167
      },
      "waitBeforePrompt": {
        "n": 3,
        "median": 0.003,
        "p90": 0.004,
        "max": 0.004
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

### s15-provider-stall-scripted: PASS

- **B12** PASS: The stuck worker was flagged in plain words on the Lead chat, the Mono rail, Being built and Today at the moment the flag was set (about 2.5 min after the 529, inside the scenario's about-2-minute window), each surface names the sub-chat so Ash opens it in one click, and the flag is gone once the job lands. Evidence: "+153s lead-worker-card: 'Show tally count on the board / Stalled' on the Tally lead rail and in the chat, with '1 worker stalled · Show'"; "+157s today-stalled: '1 has stalled: Show tally count on the board' and 'Stalled: the AI service is overloaded and stopped answering. Retrying didn't help.'"; "+157s tally-lead: 'The tally-count job stalled on a provider error. I'm retrying it with the same brief.'"; "+160s being-built-stalled: 'Stalled for 1 min'"; "+273s being-built-after: 'Nobody's working on Tally right now.'"
- **P3** PASS: The stall (not a question) was flagged in the Lead chat and on Today within the scenario window; the Lead did not ask Ash anything, retried the same brief itself, stopped the duplicate retry once the first job landed, and reported the result plainly. No blocking question after the job landed, and the flag did not linger. Evidence: "+157s tally-lead: 'The tally-count job stalled on a provider error. I'm retrying it with the same brief.'"; "+166s tally-lead: 'A retry is waiting on the same file and starts by itself if the first one finishes.'"; "+217s tally-lead: 'The heading is already in. The retry started after the stall, so I'm stopping it before it edits the same file again.'"; "+224s tally-lead: 'The board heading now shows how many tallies are on it ... Not committed. The retry after the stall was stopped'"; "delegation t-d40e751e cancelled; t-77e53825 completed"
- **CQ** PASS: The Lead talks with Ash in short plain sentences: it restates the one ask, says it is handing it to a worker and why, names the stall and the retry instead of pretending the work is fine, and closes with a concrete summary of the heading, the still-red stats test, and that nothing was committed. Evidence: "+11s tally-lead: 'The brief is one ask: show the tally count at the top of the board, and hand that to a worker.'"; "+34s tally-lead: 'That job is running: the heading will show how many tallies are on the board.'"; "+157s tally-lead: 'The tally-count job stalled on a provider error. I'm retrying it with the same brief.'"; "+224s tally-lead: 'Tests are the same as before: 11 passed, and the one stats median test is still red. Not committed.'"

