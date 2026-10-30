# Real-Claude test run

Run 20261030-192955-df11, build cos/r95 @ 818b72b, 4 min wall, 4 model turns (55 model requests, 4 helper calls), models grok-4.7, grok-4.7-build.

| Scenario | Grade | Benchmark | Key timings | Summary |
| --- | --- | --- | --- | --- |
| s15-provider-stall-scripted SCRIPTED: a worker's provider errors and goes quiet | PASS | B12, P3 | ask: 6.2s | The scripted 529 stall was flagged within about a minute in the Lead chat, on the Mono rail, on Being built and on Today, and the Lead retried it without bothering Ash. The flag cleared after the retry and the count change was reported plainly. |

## Where the time goes

```json
{
  "helpers": {
    "title": {
      "total": {
        "n": 1,
        "median": 2.447,
        "p90": 2.447,
        "max": 2.447
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
        "median": 8.034,
        "p90": 14.257,
        "max": 14.257
      },
      "waitBeforePrompt": {
        "n": 3,
        "median": 0.002,
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

- **B12** PASS: The provider stall was surfaced in plain words on all four surfaces at about the one-minute mark, with Stop/Show on the card, and the flag was gone once the retried job finished. Evidence: "+125s lead chat and Mono rail: "Tally count at the top of the board / Stalled" plus "1 worker stalled · Show" and a Stop control"; "+128s Today: "1 has stalled: Tally count at the top of the board" and "Stalled: the AI service is overloaded and stopped answering.""; "+131s Being built: "Stalled for 1 min" — "the AI service is overloaded and stopped answering.""; "+248s Being built: "Nobody's working on Tally right now.""
- **P3** PASS: The stall was flagged in the Lead chat and on Today within about a minute; the Lead retried the same brief itself and never asked Ash, then reported the landed result with no follow-up question. Evidence: "+129s tally-lead: "The tally-count job stalled on a provider error. I'm stopping that run and starting it again on the same brief.""; "+128s Today: "The Lead handed out 1 job. 1 has stalled: Tally count at the top of the board.""; "+198s tally-lead: "The board now shows how many tallies there are under the \"Team board\" heading... The old stats failure is still there and is unrelated.""
- **CQ** PASS: The Lead talks with Ash the whole way: it restates the brief, says what it is handing off and why, explains the stall and the retry, then summarises the result in a few short lines. Evidence: "+7s tally-lead: "The brief is the tally count at the top of the board. I'll find the board surface, then hand that one change to a worker.""; "+146s tally-lead: "The tally-count job stalled on a provider error, so I stopped it and started it again on the same brief.""; "+198s tally-lead: "The board now shows how many tallies there are under the \"Team board\" heading: \"0 tallies\", \"1 tally\", or \"2 tallies.\"""

