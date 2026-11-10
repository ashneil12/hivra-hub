// WP-99: recall quality holds as the store grows, and a store of two thousand lines is still fast.
//
// The store is made by a seeded generator, so every run sees the same facts and the same answers.
// Ten facts are the ones that answer the question; the rest are other coding habits. Precision is
// measured over the three lines a turn may show (RECALL_MAX_LINES).

import { describe, expect, it } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "./doc";
import { RECALL_MAX_LINES, recallDecision } from "./recallPolicy";

const MATE = "notes-lead";
const NOW = Date.parse("2026-03-01T00:00:00Z");

/** A small deterministic generator: the same seed gives the same numbers every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_666_452_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SUBJECTS = [
  "commit messages", "branch names", "release notes", "review replies", "merge order",
  "test names", "error text", "pull request titles", "todo lists", "changelog lines",
  "issue labels", "lint rules", "log lines", "doc headings", "page titles",
];
const HABITS = [
  "stay short and plain", "start with the ticket", "name the reason first", "read better lower case",
  "avoid filler words", "carry one idea", "say what changed", "name the person who asked",
  "end without a period", "use the same word twice", "lead with the verb", "skip the adjective",
];

/** The ten facts that should answer the question. Each shares two rare words with it. */
const PLANTED: MemoryItem[] = Array.from({ length: 10 }, (_, index) => ({
  id: memoryId([MATE, "planted", String(index)]),
  mateId: MATE,
  action: "add" as const,
  text: `On ${SUBJECTS[index]} the team uses the atlas schedule rule number ${index}`,
  state: "confirmed" as const,
  source: { kind: "turn" as const, ref: `turn-p${index}`, label: `turn-p${index}` },
  evidence: `On ${SUBJECTS[index]} the team uses the atlas schedule rule number ${index}`,
  support: 1,
  against: 0,
  createdAt: NOW,
  updatedAt: NOW - index * 60_000,
}));

/** Filler habits: no atlas, no schedule, and the question's words only sometimes. */
function filler(count: number, seed: number): MemoryItem[] {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const subject = SUBJECTS[Math.floor(random() * SUBJECTS.length) % SUBJECTS.length];
    const habit = HABITS[Math.floor(random() * HABITS.length) % HABITS.length];
    const text = `For ${subject} they ${habit}${index % 7 === 0 ? " and keep it small" : ""}`;
    return {
      id: memoryId([MATE, "filler", String(seed), String(index)]),
      mateId: MATE,
      action: "add" as const,
      text,
      state: "confirmed" as const,
      source: { kind: "turn" as const, ref: `turn-f${index}`, label: `turn-f${index}` },
      evidence: text,
      support: 1,
      against: 0,
      createdAt: NOW,
      updatedAt: NOW - 86_400_000 - index * 1_000,
    };
  });
}

function doc(items: MemoryItem[]): MemoryDoc {
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {} };
}

const QUESTION = "What did the team decide about the atlas schedule for commit messages?";

function precisionAtThree(size: number): { precision: number; picked: string[] } {
  const store = doc([...filler(size - PLANTED.length, size), ...PLANTED]);
  const decision = recallDecision({ doc: store, mateId: MATE, message: QUESTION, now: NOW, mode: "automatic" });
  const planted = new Set(PLANTED.map((item) => item.id));
  const good = decision.picked.filter((id) => planted.has(id)).length;
  return { precision: decision.picked.length ? good / decision.picked.length : 0, picked: decision.picked };
}

describe("recall quality against the size of the store", () => {
  it.each([50, 500, 2_000])("keeps a planted fact in every line at %i memories", (size) => {
    const { precision, picked } = precisionAtThree(size);
    expect(picked.length).toBeGreaterThan(0);
    // At every size all three lines are planted facts: quality does not decay with the store.
    expect(precision).toBeGreaterThanOrEqual(0.99);
  });

  it("does not get much worse as the store grows ten times", () => {
    const small = precisionAtThree(50).precision;
    const large = precisionAtThree(500).precision;
    expect(large).toBeGreaterThanOrEqual(small - 0.34);
  });

  it("decides a store of two thousand lines quickly", () => {
    const store = doc([...filler(2_000 - PLANTED.length, 2_000), ...PLANTED]);
    // One warm pass, then the fastest of five: a busy shared runner slows single runs, not the best one.
    recallDecision({ doc: store, mateId: MATE, message: QUESTION, now: NOW, mode: "automatic" });
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      recallDecision({ doc: store, mateId: MATE, message: QUESTION, now: NOW, mode: "automatic" });
      best = Math.min(best, performance.now() - started);
    }
    // 20 ms on a developer machine (about 8 ms measured). CI runners are two to four times slower and
    // noisy, and the point of the bound is "does not scale with the store into seconds", so it is loose there.
    const bound = process.env.CI ? 150 : 20;
    expect(best).toBeLessThan(bound);
  });

  it("shows the same lines twice in a row for the same store and message", () => {
    expect(precisionAtThree(500).picked).toEqual(precisionAtThree(500).picked);
  });

  it("shows at most the three lines the cap allows", () => {
    expect(precisionAtThree(2_000).picked.length).toBeLessThanOrEqual(RECALL_MAX_LINES);
  });
});
