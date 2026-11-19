# Measuring whether memory helps

`npm run memory:eval` runs Hivra's own recall policy over a public question set and prints a table. It is an
offline experiment, not part of `npm run check` and not part of CI: it needs one download, and a run takes a
few minutes on a laptop.

## What it measures

For each question it asks one thing: did the lines the policy showed carry what a right answer needs?

The set is PersonalizationV4's test split. Each row carries a question, five candidate answers (one right, four
wrong), and the user's 200 two-turn chats. The script turns each user's chats into Hivra memories, one per
sentence in the person's own words, confirmed and stamped with a fixed time. Then it asks the real
`recallDecision` in automatic mode, with a fixed `now`, which lines it would show for each question. The code is
bundled from `src/features/memory/model/` at run time, so the measurement always follows the working tree.

Six arms run over the same store, so they differ only in which lines they pick:

| Arm | What it picks |
| --- | --- |
| policy | the shipped recall policy, at most 3 lines |
| overlap top 3 | the 3 lines sharing the most words with the question |
| overlap top 10 | the 10 lines sharing the most words with the question |
| first 3 lines | the three oldest memories, the do-nothing control |
| best 3 lines | the 3 lines that together carry the most of the answer's claim, the realistic ceiling for a 3-line turn |
| all lines | every memory, the upper bound |

The table reports, per arm: questions run, hit rate, mean share of the answer's claim carried,
the share of questions where any line was shown, mean lines shown, and the median time per decision.
A hit means the lines that arm showed carried at least half the claim's weight. The policy and the other
three-line arms never show more than three lines, so their hit rate is a hit at three. The all-lines hit
rate is the upper bound: the claim was somewhere in the store, with no cap on how many lines it took.

## What it does not measure

- **Not whether an answer would be right.** It measures whether the material reached the turn, not whether a
  model used it well. A high score is not a good answer.
- **Not coding usefulness.** PersonalizationV4 is about everyday preferences from chats, not about a coding
  agent's memory.
- **Not exact, on this data.** The dataset does not say which chat holds the evidence for each question, so a
  hit is scored by a weaker proxy (below), and the report says so plainly.
- **Not the whole split.** The default slice is three users and about 400 questions with a fixed seed, to keep
  a run short. `--users` and `--questions` widen it.
- **Not a ranking of the policy against a model.** The other arms are baselines within Hivra's own store shape.

### The proxy

Each question ships five candidate answers. The four wrong ones are written to share the question's situation
and differ only in the preference they express. So the answer's claim words are the words its answer uses and
its distractors do not, capped at eight and read with the policy's own word reader. Each claim word is weighted
by how rare it is in the store (inverse document frequency). A question counts as a hit at three when the union
of the lines an arm showed carries at least half the claim's weight.

That measures whether the preferences a right answer needs reach the turn. It cannot tell whether the model
would have used them.

## Data, licence and attribution

The data is PersonalizationV4 from [Memorilla](https://github.com/snap-stanford/memorilla): dataset
`memorilla/PersonalizationV4` on Hugging Face, file `data/test.parquet`. The personas are seeded from Google's
Synthetic-Persona-Chat (Jandaghi et al., 2023).

It is licensed **CC BY 4.0**. That requires attribution when the material is shared or adapted. So:

- **Data:** PersonalizationV4, by Memorilla (Stanford SNAP), licensed CC BY 4.0, with personas from
  Synthetic-Persona-Chat by Jandaghi et al. (2023). The file is fetched on demand from
  `https://huggingface.co/datasets/memorilla/PersonalizationV4` and never copied into this repository.
- **Idea:** an external test set for chat-derived memory, and the habit of reporting an arm ladder (closed book,
  retrieval at several depths, full context) rather than one number, come from Memorilla's evaluation
  (`docs/evaluation.md`, `evaluate_baselines.py`).

No Memorilla code or prompt text is copied. The reader, the converter and the scorer are Hivra's own.

## How to run it

```bash
npm run memory:eval                 # 3 users, about 400 questions, seed 106
npm run memory:eval -- --store 0    # no cap on memories per user (slower, about 25s a user)
npm run memory:eval -- --users 5 --questions 700
npm run memory:eval -- --file path/to/test.parquet
```

The first run downloads `data/test.parquet` (about 7.5 MB) into `~/.cache/hivra-eval/`, prints its size and
sha256, and reuses it after that. The script records the sha256 it was written against; a different copy still
runs but the script says the numbers may not compare. If the download fails or the dataset has moved, the script
stops with a message naming the dataset and the file, and nothing else is touched.

No key, account or model is used. The only network call is that one file.

## The tests

`node --test scripts/memory-eval/*.test.mjs` runs the reader, the converter, the scorer and the runner against a
small Parquet file built byte by byte in `scripts/memory-eval/testFixtures.mjs`. Nothing in the repository holds
dataset content or anything derived from it. The tests also run a full pass over the hand-made file with the real
policy, so the wiring is exercised without the download.

## Long chats: the no-model test bed (13 Nov 2026)

`npx vitest run src/features/asks/testbed` builds made-up first-mate chats of 100, 1,000 and 10,000 messages
(`src/features/asks/testbed/fakeChat.ts`, the same chat every run) and puts them through the real no-model code:
the ask ledger's reading of each message, `chat.search`, the tidy brief and state card, and the daily check. Each
chat has facts planted about every 50 messages and messages with 3 to 6 unnumbered asks about every 40.

| Messages | Planted asks kept | Extra lines kept | Planted facts found first | One search | Reading every message |
| --- | --- | --- | --- | --- | --- |
| 100 | 9/9 | 0 | 2/2 | under 0.1 ms | under 1 ms |
| 1,000 | 106/106 | 1 | 20/20 | 0.1 ms | 16 ms |
| 10,000 | 1089/1091 | 1 | 200/200 | 1.0 ms | 1,080 ms |

What this says: with no model at all, the ledger keeps the asks in a long unnumbered message in Ash's words, a fact
said 9,000 messages ago is one search away, and search over the chats the app already holds needs no index at this
size. The test fails if ask recall drops under 9 in 10, if a planted fact is not the first hit, or if a tidy's
brief grows with the chat.

What it does not say. The made-up asks are plainly worded ("can you", "please", "we need to", "make sure"), so
real messages will do worse on the rules alone; that is what the model reading of long messages is for, and it is
not measured here. Not measured either: whether a first mate's replies honour a correction or refuse a fact that
was never said, the LongMemEval slice, and the cost per turn. Those need a real engine and are still to do.
