# WP-241: Two-tier recall: a small always-sent core and a search tool for the rest

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | M | WP-99, WP-240 | yes |

## Goal

Recall scales past a few dozen facts without growing every turn. A small essential set is always in the turn, and the
rest is reached by search.

## Why

- Hivra picks at most `RECALL_MAX_LINES = 3` facts per turn with a scored, model-free policy (`recallPolicy.ts`).
- nightly-labs OpenBot (ideas only) splits memory into "essential" (always sent, capped at 8 KB) and "searchable"
  (reached through a database search tool). It also ties some memories to a website, shown when the agent opens
  that site.
- Nod (Apache-2.0) gives a cheap model a 1-second shared deadline to plan and rank recall. The model may only
  return ids the server supplied, and recall falls back to lexical search when the deadline passes.
- Research: `reports/nod.md` item 8, `reports/nightly-openbot.md` (memory section).

## Build

1. **Essential set.** Every confirmed fact marked essential (by Ash, or by having been recalled often), capped at
   4 KB per first mate. It goes in a per-chat context message, fenced as untrusted as now. It is re-sent only
   when it changes and after a compaction.
2. **Search tool.** `memory.search` for first mates and crew runs over the whole store with the existing lexical
   match. It returns ids and text and says `truncated` or `complete`.
3. **Optional model rank.** When the cheap tier is on, it ranks candidates within 1 s. It may only return ids from
   the candidate list. Otherwise `recallPolicy` stays as it is, as the fallback.
4. **Changes as a small block.** When memory changes between turns, put a short "what changed" block in the next
   user turn rather than editing earlier context, so the provider's prompt cache survives.

## Done when

- [ ] Tests:
  - the essential cap holds;
  - search returns only stored ids;
  - the rank's deadline falls back to lexical search;
  - an id the model invents is dropped;
  - the changes block is sent once.
- [ ] `node --test scripts/memory-eval/*.test.mjs` has no regression on recall quality.
