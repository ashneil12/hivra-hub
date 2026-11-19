# WP-216: First launch, the owner batch and what it knows about you

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| N | L | WP-215 (the captain's pick on each passed-up item), WP-211 (overturns), WP-156 (standing answers) | yes |

## Goal

Ash gets his decisions twice a day as one numbered message in the Chief of Staff's chat and answers them all in one
line, "1b 2a 3 skip". The captain learns from those answers and from his overturns, asks him a short set of
calibration questions once a week, and shows everything it has learned on one page he can edit.

## Why

Ash, 11 Nov 05:33: the captain "can be customised to your personality and it learns", with "decisions minimal and
important when it needs you". The tips he shared the same morning: "ask me 100 questions with suggested 4 answers" and
answering "1b 2a". In 0.16.15 every question arrived alone, whenever an agent asked it, and nothing an answer taught
the app was kept beyond WP-156's standing answers.

## Read first

- [UX.md](../UX.md) "The chain of command"; the journey doc's "Day 0", "When it needs you" and "How it learns you"
  (<https://claude.ai/artifact/LKCuZMvcJVP4hf64Ukcm3V>).
- WP-210's `needsYou.ts` (each item's own answer handler), WP-215's decision order (step 4 reads this package's
  preferences), WP-156's standing answers, WP-211's overturn.
- The Chief of Staff's memory (Mono memory files) and the secret patterns (one list for the webview and Rust).

## Build

1. **First launch.** The first time Home opens with a Chief of Staff and no preferences, its chat starts with a short
   hello and five numbered questions with lettered answers: what to call Ash; how often to hear from it (twice a day,
   the default; once; as it happens); a daily spend limit (none set, $10, $50, his own); which engine (the ones
   installed); and how much to decide for him (the most, the usual, ask more). He can answer in one line or skip; each
   answer is saved as a preference (item 5) or as the setting it names. Nothing is asked again once answered.
2. **The owner batch.** Items the captain passes up (WP-215) that are not urgent wait for the next batch time (08:00
   and 18:00 by default, set in Settings › Chief of Staff). At that time the captain posts one message in its Home
   chat: each item numbered, with lettered options and "(suggested)" on its pick, grouped by project. The items stay
   in Needs you the whole time (the list is still the truth); the batch is how they are presented. With nothing
   waiting, no message is posted.
3. **Answering in one line.** A plain-code parser reads Ash's reply: `1b`, `2 a`, `3 skip`, `4: <words>` for a free
   answer, and "all suggested" or "ok" to take every pick. Each answer goes through that item's own handler, exactly
   as a tap in Needs you would. A reply it can't read whole (an unknown number, a letter that isn't an option, an item
   already answered elsewhere) answers nothing and says which part it couldn't read. A reply that isn't batch-shaped is
   an ordinary chat turn.
4. **Urgent goes now.** An item the captain marks urgent skips the wait and posts at once: a security finding, spend
   running past a limit, a ship that failed, or a first mate stopped on the only path to something Ash asked for today.
   At most three urgent posts a day; past that they wait for the batch and the captain says so.
5. **What it learns.** A `preferences` table in the app's database: scope (one project or all), the kind of call, when
   it applies (a sentence), the answer, where it came from (first launch, batch, calibration, overturn), when it was
   made and last used, and how often. Text is run through the secret patterns and refused like any other field.
   WP-215's step 4 reads it.
6. **"Same answer next time?"** After a batch answer to a kind of call that repeats, the captain's next message asks
   once: "Same answer next time? (y/n)". Yes saves a standing answer (WP-156) for that project and kind. It is never
   offered for a person-only key or a red-line item.
7. **Overturns teach.** An overturn (WP-211) adds one line to the next batch: "You changed <what> from X to Y. Next time
   do Y?". Yes saves a preference; no saves nothing. The standing answer or preference that made the overturned call is
   paused until Ash answers.
8. **Calibration.** Once a week (Sunday's first batch) or from Settings › Chief of Staff › "Ask me questions", the
   captain asks up to 20 numbered questions with four lettered answers each, drawn from that week's passed-up items and
   overturns ("When a pull request's checks fail twice, should Coding a) retry once b) ask you c) stop d) ..."). The
   answers become preferences. A week with nothing to ask asks nothing.
9. **What I know about you.** A Settings page lists every preference (with Edit and Forget) and the lines of the Chief
   of Staff's memory about Ash (with Forget). Forgetting removes it for good and the captain's next turn no longer sees
   it.

## Done when

- [ ] Tests:
  - first launch asks once, saves each answer, and asks nothing after;
  - a non-urgent passed-up item waits for the batch time and stays in Needs you meanwhile; an empty batch posts nothing;
  - the parser: every form above, "all suggested", and each unreadable reply answering nothing and naming what it
    couldn't read; an answer through the batch removes the item from Needs you everywhere;
  - urgent items post at once, at most three a day;
  - preferences round-trip, a key-shaped text is refused, and WP-215's step 4 picks one up;
  - "Same answer next time?" is never offered for person-only or red-line items, and yes writes a standing answer;
  - an overturn pauses the rule that made the call and offers the new answer once;
  - Forget removes a preference and a memory line.
- [ ] Browser spec `tests/browser/wp216-owner-batch.spec.ts` with example data: the first-launch questions, a batch
  message answered with "1b 2a", the calibration set and the "What I know about you" page, with 1440 × 900
  screenshots.
- [ ] Before and after screenshots in the PR (example data); the same from a seeded dev copy kept on the Mac
  (`~/Worktrees/ux-shots/WP-216/`, never pushed).
- [ ] `npm run check` passes.
