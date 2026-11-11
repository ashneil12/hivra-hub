# WP-188: Memory says why it kept, refused or put off each fact

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 51 | yes |

From PLAN.md, "From oh-my-hermes", item 3 (reasoned memory). oh-my-hermes is MIT (read at commit `2676c33`); idea
only, credited per SOURCES.md. WP-148 already took two small oh-my-hermes memory fixes; this adds no second memory
model.

## Goal

The person can open a Mono's memory and see, for every fact it was offered, whether it was kept, refused or put off,
with one written reason each; a likely copy of an existing fact is flagged before it lands; and a turn's recalled
memory stays under a size budget and says what it left out and why.

## What Hivra has

- The curator (`src/features/memory/model/curator.ts`): after a first-mate turn, zero or one durable fact.
  `CuratorOutcome` is `none`, `deferred`, `stored`, or `dropped` with `late`, `secret`, `ungrounded`, `invalid` or
  `orders`. The outcome is used and then forgotten; nothing keeps it for the person.
- Facts (`model/doc.ts`, `MemoryItem`): `state` `unreviewed`, `confirmed` or `edited`, with `evidence`, `source`,
  `support`, `against`, `fade` and `dispute` (WP-111, `contradicts.ts`). Saved by `src-tauri/src/memory_review.rs`.
- Recall (`model/recallPolicy.ts`, WP-99): a scored pick of at most `RECALL_MAX_LINES` (3), with rejection reasons
  (`REJECT_LABEL`: `duplicate`, `held_back` and the rest) and a trace the Memory screen shows
  (`model/lastRecall.ts`, "Why these were recalled").
- `src/features/memory/backpass/similarity.ts` (Dice over word bigrams) and `backpass/tokens.ts` (a token estimate),
  both MIT and already credited.
- WP-103's budget (`model/memoryBudget.ts`) is why a turn is put off.

## What to build

1. **An admission record.** Every curator outcome writes one row: `admitted` (keep), `refused` or `deferred`, the Mono,
   the time, the candidate text (secrets are never written: a `secret` refusal stores the reason only), and one reason
   sentence. Keep: the curator's own grounding ("you said so on 9 Nov"). Refuse: the `dropped` reason in words, or
   "nothing worth keeping" for `none`. Defer: "memory budget used up for this hour" or "the curator timed out". At
   most 200 rows per Mono, oldest dropped. Kept in the Mono's memory doc beside the facts, through the same
   compare-and-swap save.
2. **A "Decisions" tab** on the Memory screen (`src/features/memory/ui/MemoryReview.tsx` gets a tab hook): the rows,
   newest first, filterable by keep, refuse and defer. A refused row has "Keep it anyway", which adds the fact as
   `unreviewed` with the person as its source.
3. **Duplicate hints at admission.** Before a fact is stored, `similarity` against the Mono's existing facts; at or
   above 0.8 the fact is stored `unreviewed` with a hint "looks like a copy of: <other fact>" and both are shown side by
   side on review with Merge, Keep both, Drop new. Nothing is merged without the person.
4. **A recall budget in tokens.** `recallDecision` keeps its three-line cap and adds a token cap (default 400, from
   `backpass/tokens.ts`). A memory left out by the cap gets a new reason `over_budget` ("left out: the recall was
   full"), shown in the existing trace.

## Rules

- Changes no fact's text or state on its own; the person decides on every hint.
- No new model call: reasons come from what the curator already returned and from code.
- No new outward network call. Secrets are never stored, shown or exported (the existing `mentionsSecret` check).
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists).
- Credit oh-my-hermes (MIT) for the idea in the PR and update its row in SOURCES.md.
- Upstream rules from PLAN.md: memory modules are Hivra's own; `MemoryReview.tsx` gets a tab hook.

## Done when

- [ ] Red first: a curator test settles a `dropped: ungrounded` turn and expects one `refused` row with its reason; it
      fails before the record exists.
- [ ] Tests: each outcome writes one row with the right state and reason; a secret refusal stores no candidate text;
      rows cap at 200; two windows saving at once keep both rows (the existing revision check).
- [ ] Tests: a 0.85-similar fact is stored `unreviewed` with its hint; Merge, Keep both and Drop new each do what
      they say; a recall over 400 tokens leaves out the lowest scored memory with `over_budget`.
- [ ] Browser spec `tests/browser/memory-decisions.spec.ts`: the Decisions tab with seeded rows, "Keep it anyway",
      and a duplicate pair on review. Screenshots in the PR.
- [ ] `npm run check` passes.

## Not in this package

Embeddings or a vector store. Changing what the curator keeps. Memory for workers (WP-83).
