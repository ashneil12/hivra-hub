# WP-23: Council

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| C | L | 22 | no |

## Goal

A council: a group preset for hard calls, whose rules are enforced by code, with seats on different CLIs and model
families, ending in a verdict a first mate can act on.

## Why

Ash's "council of high intelligence, different minds to bounce ideas off". SPEC.md section 6. The protocol from
0xnyk/council-of-high-intelligence (MIT) is the best-specified one found; it runs as a prompt there, so models can
skip steps. Here code runs it.

## Read first

- council-of-high-intelligence: `SKILL.md` steps 0 to 8 (panel, routing, restate gate, chairman, blind round,
  anonymised cross-exam, enforcement scan, final round, tie-break, verdict, metadata), `agents/council-*.md` (18
  personas), `configs/`.
- WP-22's rooms and responder machinery; `harness.rs` for which CLIs are signed in.

## Build

1. **Convene** from any first mate chat (`/council <question>`) or a group's menu. The first mate proposes a panel
   (preset: quick 2, triad 3, full 5) with a seat per CLI and model family where available, and shows the expected
   number of calls before the person confirms.
2. **Rounds, enforced**: restate the question (a gate: the person confirms or corrects); blind answers in parallel
   (no seat sees another's); cross-examination with names hidden (Member A, B, C); final stance lines in a fixed
   shape (option, confidence, one-line reason). Code checks each round's output shape and asks once again if it's
   wrong.
3. **Tally in code**: weights and a two-thirds line; "no consensus" is a valid result; the minority view is always
   kept.
4. **Chairman**: a seat on a different provider from most of the panel writes the verdict in a fixed template:
   unresolved questions first, kill criteria, the concrete next step, the minority report.
5. **Acting on it**: the convening first mate gets the verdict and can delegate the next step as a normal brief.
6. **Personas** are files (vendor the 18 with credit, MIT) and plugins can add more (WP-30). Each seat can take a
   persona or none.
7. **UI**: a column per seat with its CLI and model, a round indicator, the stance bar with the two-thirds line, and
   the minority report highlighted. Each seat opens as its own session tab.
8. Record each run's metadata (seats, rounds, calls, tokens if known) on the room.

## Done when

- [ ] Tests with fake models: blind round isolation, anonymisation, malformed stance retried once, tally maths,
      no-consensus outcome, chairman on a different provider when one is available.
- [ ] Browser spec of a full run with screenshots; `npm run check` passes.
