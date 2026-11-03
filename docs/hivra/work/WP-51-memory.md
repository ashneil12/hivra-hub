# WP-51: Memory curator, review screen, long chats everywhere

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| D | L | 50 | no |

## Goal

Memory a person can see and trust: each first mate keeps at most one durable fact per turn (or none), turns
repeated procedures into skill proposals, and the person reviews, edits and deletes memory in one screen. Long chats
stay usable for every first mate, not only opted-in Monos.

## Why

Vision item 6, without memory silently rewriting behaviour (OpenBot's review states, Rerun's curator idea, Agent
Zero's memory screen, Mercury's beliefs with evidence).

## Read first

- `src/features/monos/model/monoTree.ts` and its store (UniiChat's tree, Apache-2.0, credited), `mono_home.rs`
  (SOUL.md and MEMORY.md), `src/features/selfBuild/model/skillLearn.ts`.
- WP-50's output format.

## Build

1. **Curator** after each first-mate turn: a cheap model proposes zero or one durable fact, an update or a removal
   of a stale one, or a skill proposal for a repeated procedure. Facts go to memory as unreviewed; skills only
   become skills when the person accepts them.
2. **Memory screen**: everything a first mate remembers, with its source and state (unreviewed, confirmed, edited),
   search, edit, delete, and accept or reject for proposals (including WP-50's import).
3. **Recall** places relevant memory inside the turn, fenced as untrusted, not in the system prompt.
4. **Long chats everywhere**: the summary tree is used for any first mate chat past a size threshold, not only for
   Monos with "keep one long chat".

## Done when

- [ ] Tests: zero-or-one fact per turn, skill proposal accepted and rejected, recall fenced, tree used past the
      threshold.
- [ ] Browser spec of the memory screen; `npm run check` passes.
