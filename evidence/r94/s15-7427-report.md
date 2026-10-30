# Real-Claude test run

Run 20261030-184532-7427, build cos/r94 @ d91f0c8, 7 min wall, 9 model turns (162 model requests, 4 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| s15-provider-stall-scripted SCRIPTED: a worker's provider errors and goes quiet | PASS | B12, P3 | ask: 7.4s | The provider stall was flagged in plain words within about a minute on the Lead chat, the Mono rail, Being built and Today, with a one-click way into the worker, and the Lead retried on its own, reported the landed count plainly, and the flag cleared. The Lead also kept Ash informed in short, plain messages throughout. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 3.822,
        "p90": 3.822,
        "max": 3.822
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
        "n": 3,
        "median": 1.724,
        "p90": 14.158,
        "max": 14.158
      },
      "waitBeforePrompt": {
        "n": 3,
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

### s15-provider-stall-scripted: PASS

- **B12** PASS: The scripted 529 stall was surfaced in plain words on all four surfaces well inside the window (the Being built card already read 'Stalled for 1 min' at +129s, so it was flagged about a minute after the worker went quiet), and Ash had a one-click 'Show' into the sub-chat plus inline Stop/Send. Evidence: "+123s lead-worker-card: 'Show tally count at the top / Stalled' and '1 worker stalled · Show', with the Mono rail entry 'Show tally count at the top / Stalled / Tally'"; "+126s today: 'The Lead handed out 1 job. 1 has stalled: Show tally count at the top.' and 'Stalled: the AI service is overloaded and stopped answering.'"; "+129s being-built: 'Stalled: the AI service is overloaded and stopped answering. Retrying didn't help. Stalled for 1 min'"
- **P3** PASS: The stall was flagged in the Lead chat and on Today within about a minute, the Lead handled it itself with one retry instead of blocking Ash with a question, reported the outcome plainly, and the flag was gone once the job landed. Evidence: "+132s [tally-lead chat] The first worker stalled on a provider error. I'm starting it again on the same job."; "+141s [tally-lead chat] The tally count is still with the first worker, which stalled and may pick back up. A second pass of the same job is waiting behind it..."; "+375s [tally-lead chat] The tally count is in, not committed. Under "Team board" it shows how many tallies there are (0 tallies, 1 tally, 3 tallies)... UI tests: 3 passed."; "+425s being-built-after: 'Nobody's working on Tally right now.'"
- **CQ** PASS: The Lead talks with Ash the whole way: it acknowledges the ask, says what it is doing and why in short plain sentences, narrates the stall and the retry rather than working silently, checks the files before calling it done, and closes with a concrete summary. Evidence: "+8s [tally-lead chat] The board should show the tally count at the top. I'll hand that to a worker and start it now."; "+177s [tally-lead chat] The first pass finished without changing the board. I'm checking the project and whether the retry has started."; "+364s [tally-lead chat] The report says the count landed. I'm reading the board files before I call it in."

