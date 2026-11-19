# WP-145: Fact-based done gate before a worker's "done" counts (AgentMon)

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| Tonight finds (9 Nov 9pm) | M | WP-40 / firstmate `gates.rs`; complements WP-81 no-mistakes | yes |


## Goal

When a delegated worker (or a lead Claude Code turn that claimed the job finished) reports done, Hivra refuses that claim if session facts show unfinished work: failed checks this turn, checks that went stale after a later edit, edited packages no test reached, open todos, or an answer that claims tests/build pass with no matching check after the last code edit. The person sees why it was sent back.

## Why

[codenotary/agentmon-live](https://github.com/codenotary/agentmon-live) (Apache-2.0, commit `296502feec4707f6f1a8e8b9383f8fccc3aef2ea`): a Done Gate on Claude Code Stop that checks transcript facts before the agent wraps up. Hivra already runs configured brief gates in `src-tauri/src/firstmate/gates.rs` ("a worker saying done is a claim") and can pin no-mistakes (WP-81 / WP-140). What is still thin is the *fact* layer AgentMon encodes in `hooks/gate.ts` / `doneGaps`: stale-after-edit, uncovered targets, empty or dropped test runs, and "tests pass" claims without evidence. Port those checks into Hivra's gate path; do not vendor the AgentMon pane or web UI.

## Read first

- AgentMon (read-only clone, then delete): `hooks/gate.ts` (`doneGaps`, `coverageGaps`, `claimOf`), `hooks/done.ts` overview, `README.md` Done Gate section. Licence Apache-2.0. Plugin author `vchaindz`; if a source file has no Copyright line, do not invent one in NOTICE (gion rule); credit the repo and Apache-2.0 in SOURCES and only add a NOTICE copyright when the file header or LICENSE names one.
- Hivra: `src-tauri/src/firstmate/gates.rs`, delivery README, WP-40 / WP-81 docs, crew task card "done" / "checking" copy (`appSince.ts`).

## Build

1. **Docs first.** Copy this file to `docs/hivra/work/WP-145-done-gate-facts.md`. SOURCES.md row for agentmon-live. If translating `doneGaps` / `claimOf` / `coverageGaps`, add file headers, credits.json, NOTICE only with a copyright line actually read from the source (else SOURCES-only + "translated without a named copyright line in upstream LICENSE footer").
2. **Pure fact checks.** TypeScript (and matching Rust if gates stay in Rust) functions that, given this turn's checks, edits, test runs, open todos, and the final answer text, return a list of gap strings. Port the behaviour of AgentMon's `doneGaps` / `coverageGaps` / `claimOf`, with Hivra's plain wording (no em dashes). Tests from AgentMon's cases where licence allows copying test ideas; write Hivra tests either way: failed this turn, stale after edit, claim without evidence, open todo, uncovered package, docs-only edit ignored.
3. **Wire into firstmate gates.** After configured gates, or as an earlier soft check when the worker said done, run the fact gaps. Any gap fails the done claim once and sends the worker a fix round with the gap list (same shape as today's red-check fix round). A second failure fails delivery. Do not call a cloud advisor (AgentMon's optional Fable consult stays out unless already available as a local cheap model and behind an off-by-default flag).
4. **Visible copy.** Task card / Inbox: "Sent back: tests went stale after the last edit" (example). Browser or unit coverage for the sentence builder.
5. **Out of scope.** Do not install the AgentMon Claude plugin into `~/.claude`. Do not port the live pane, web view, i18n packs, or Fable advisor. No new network listener.

## Copy with credit

- Source: codenotary/agentmon-live at `296502feec4707f6f1a8e8b9383f8fccc3aef2ea`, Apache-2.0.
- Prefer a line-by-line TypeScript translation of the pure functions in `hooks/gate.ts` with tests. Skip UI.

## Done when

- [ ] Fact gaps fail a done claim with a clear reason and one fix round.
- [ ] Docs-only edits do not trip coverage gaps.
- [ ] SOURCES (and credits/NOTICE if code was translated) are correct; `credits.test.ts` green if they changed.
- [ ] No AgentMon pane or `~/.claude` install in the diff.

## Licence

Apache-2.0 (agentmon-live). Do not invent a copyright holder if upstream LICENSE only has the Apache placeholder; name the repo and licence in SOURCES either way.
