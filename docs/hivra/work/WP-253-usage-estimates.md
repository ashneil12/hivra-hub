# WP-253: Usage shows an API-equivalent estimate and cache savings, labelled as estimates

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| P | S | 108, 176 | yes |

## Goal

The Usage page can show, next to what the CLIs reported, what the same tokens would cost at public API rates, and how
much cache reads saved, for every engine, including the ones that report no price (Codex, Grok, Pi and others).

## Why

Up.computer's Usage (docs/user/usage.md, MIT) shows "token use, cache savings, model breakdowns, and estimated
API-equivalent cost", and says plainly "these estimates are not your subscription bill". Hivra's Usage
(`src/features/usage/model/history.ts`) shows only measured prices, so most engines show tokens and no money.

## Build

1. A rate table (`src/features/usage/model/rates.ts`) for the models the app offers: input, output, cache read and
   cache write per million tokens, each with its source page and the date it was read. Unknown models get no estimate.
2. History gains `estimatedUsd` and `cacheSavedUsd` per row, computed only from tokens and the table.
3. The page shows "Estimated at API rates" as a separate, muted figure with the line "An estimate, not your bill."
4. **Spend limits never read an estimate.** `spendGate` and `taskCeiling` keep using measured cost only; a test fails
   if an estimate reaches them.

## Done when

- [ ] Tests: estimate math, unknown model gives none, cache savings, spend limits ignore estimates.
- [ ] Before/after screenshots of the Usage page.
