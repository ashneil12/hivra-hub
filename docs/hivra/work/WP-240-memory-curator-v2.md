# WP-240: Memory that learns from repetition, keeps a "Let go" archive and runs in batches

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| O | M | WP-51, WP-100, WP-111 (all merged) | yes |

## Goal

Memory gets cheaper and easier to trust. The curator stops running after every first-mate turn. "Remember that ..."
saves at once, as confirmed. Everything else is learned in batches. A fact says how sure memory is, by how often Ash
said it. A replaced fact goes to a "Let go" list with the reason, instead of being lost. Hard rules (expiry,
duplicates, one-off guesses) run without a model.

## Why

- Nod (n8n, Apache-2.0, commit d82e06e) learns in two ways: an explicit `memory_learn` saves a fact as confirmed,
  and an hourly batch reads new owner messages 40 at a time. The batch saves its watermark in the same
  compare-and-swap write as the facts, so it applies once.
- nightly-labs OpenBot (PolyForm Noncommercial, so ideas only, no code or text) batches its curator every 20 turns,
  after 15 minutes idle, on clear, or when a side thread closes. It never touches memory the person wrote, and it
  drops a batch if memory changed while it read.
- Research: `/mnt/project-files/hivra-research/reports/nod.md` section 6 items 2 to 6;
  `reports/nightly-openbot.md`.

## Read first

`src/features/memory/model/curator.ts`, `ruleCurator.ts`, `review.ts`, `fade.ts`, `doc.ts`,
`src/app/hooks/useMemoryCurator.ts`. Nod: `src/server/memory-learning.ts` (`remember`, `batch`, the `reflected`
watermark), `memory-tree.ts` (`statusOf`, `archivedSchema`, `archive`), `memory-lint.ts` (`repair`, `better`).

## Build

1. **Two paths.**
   - Explicit: the rules tier's "remember that ..." stores the fact as `confirmed`, as now, and gives a one-line
     reply.
   - Batch: the cheap curator runs over Ash's messages since a watermark kept in `MemoryDoc` and saved in the
     same commit as the facts. It runs every 20 first-mate turns, after 15 idle minutes, or when a chat closes,
     whichever comes first. It reads at most 40 messages per call and retries at most 3 times. Evidence rules
     stay as in #284: only Ash's own words.
   - Never rewrite an item whose state is `confirmed` or `edited`. Drop the batch if the doc's revision changed
     while the model ran.
2. **Status from corroboration.** Show "Mentioned once" (support 1), "Learned" (two distinct source messages) and
   "Confirmed" (Ash confirmed or edited it). A repeat adds evidence; it does not make a new row. This reuses
   `support`, so there is no new counter.
3. **Let go archive.** Archiving keeps the item with `letGo: { reason, by?, at }`. The reason is one of
   superseded, duplicate, expired, stale, contradicted or manual. `by` names the replacing item. The Memory screen
   gets a "Let go" tab with "Bring back". Delete stays the hard forget, with the #284 digest.
4. **No-model repair pass**, run with the batch:
   - archive expired facts (`validTo` in the past);
   - archive a single-source guess not repeated in 60 days (not events or possessions);
   - merge normalised duplicates, keeping the stronger one;
   - cap the archive at 500, oldest out first.

   Keep `fade.ts` for ranking only, so two decays never act on one field.
5. **Typed details** (optional fields): `kind` (fact, preference, plan, event or possession), `entities`,
   `occurredOn`, `validFrom` and `validTo`. Add Nod's curator rules to the prompt: a plan is not a completed event,
   owning something does not prove a purchase, and a question does not confirm a fact. If prompt text is copied,
   credit it in NOTICE.

## Done when

- [x] Tests:
  - the batch applies once under a lost compare-and-swap;
  - a confirmed or edited item is never rewritten by the batch;
  - each status label is shown;
  - "Let go" and "Bring back" work;
  - each repair rule runs;
  - an old doc loads unchanged.
- [x] Browser spec of the Memory screen's "Let go" tab, with before and after screenshots.
- [x] Credits: no Nod code or prompt text was copied (ideas only), so NOTICE is unchanged; credits.json names what Nod gave.
