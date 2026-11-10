import { beforeEach, describe, expect, it } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "./doc";
import { recallDecision } from "./recallPolicy";
import {
  RECALL_TRACES_MAX,
  RECALL_TRACE_REASONS_MAX,
  forgetRecall,
  lastRecallFor,
  latestRecall,
  recallSummary,
  recordRecall,
} from "./lastRecall";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const MATE = "notes-lead";
let serial = 0;

function item(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  serial += 1;
  return {
    id: memoryId([MATE, extra.action ?? "add", text.toLowerCase(), String(serial)]),
    mateId: MATE,
    action: "add",
    text,
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function doc(items: MemoryItem[]): MemoryDoc {
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {} };
}

beforeEach(() => forgetRecall());

describe("the last turn's trace", () => {
  it("counts what was picked and why the rest were skipped", () => {
    const picked = item("Likes small commits");
    const unreviewed = item("Likes medium commits", { state: "unreviewed" });
    const archived = item("Likes huge commits");
    const removal = item("Remove: likes huge commits", { action: "remove", state: "unreviewed", targetId: archived.id });
    const decision = recallDecision({
      doc: doc([picked, unreviewed, archived, removal]),
      mateId: MATE,
      message: "How do you like to write commit messages for a branch?",
      now: NOW,
      mode: "automatic",
    });
    recordRecall(decision, NOW);
    const trace = lastRecallFor(MATE)!;
    expect(trace.picked).toBe(1);
    expect(trace.skipped).toBe(3);
    const summary = recallSummary(trace);
    expect(summary).toContain("picked 1, skipped 3");
    expect(summary).toContain("needs review 1");
    expect(summary).toContain("archived 1");
  });

  it("says in plain words when a whole turn was stopped", () => {
    const decision = recallDecision({
      doc: doc([item("Likes small commits")]),
      mateId: MATE,
      message: "hi there",
      now: NOW,
      mode: "automatic",
    });
    recordRecall(decision, NOW);
    expect(recallSummary(lastRecallFor(MATE)!)).toBe("Nothing was recalled: the message was a greeting.");
  });

  it("keeps at most four reasons, the biggest first", () => {
    const items = [
      item("Likes small commits"),
      ...[1, 2, 3, 4, 5].map((n) => item(`Likes commit note ${n}`, { state: "unreviewed" as const })),
    ];
    recordRecall(
      recallDecision({ doc: doc(items), mateId: MATE, message: "How do you like to write commit messages?", now: NOW, mode: "automatic" }),
      NOW,
    );
    const trace = lastRecallFor(MATE)!;
    expect(trace.reasons.length).toBeLessThanOrEqual(RECALL_TRACE_REASONS_MAX);
    expect(trace.reasons[0]).toEqual({ label: "needs review", count: 5 });
  });

  it("gives the latest turn when the screen does not know the Mono", () => {
    recordRecall(
      recallDecision({ doc: doc([item("Likes small commits")]), mateId: "a", message: "How do you like to write commit messages?", now: NOW, mode: "automatic" }),
      NOW,
    );
    recordRecall(
      recallDecision({ doc: doc([{ ...item("Likes small commits"), mateId: "b" }]), mateId: "b", message: "How do you like to write commit messages?", now: NOW, mode: "automatic" }),
      NOW + 1,
    );
    expect(latestRecall()!.mateId).toBe("b");
    expect(lastRecallFor("a")!.mateId).toBe("a");
  });

  it("keeps at most sixteen Monos, dropping the least recent", () => {
    const store = doc([item("Likes small commits")]);
    for (let index = 0; index < RECALL_TRACES_MAX; index += 1) {
      recordRecall(
        recallDecision({ doc: store, mateId: `m-${index}`, message: "How do you like to write commit messages?", now: NOW, mode: "automatic" }),
        NOW + index,
      );
    }
    recordRecall(
      recallDecision({ doc: store, mateId: "newest", message: "How do you like to write commit messages?", now: NOW, mode: "automatic" }),
      NOW + 100,
    );
    expect(lastRecallFor("m-0")).toBeUndefined();
    expect(lastRecallFor("newest")).toBeDefined();
  });
});

describe("one decision across Monos", () => {
  const MESSAGE = "What do you remember about writing small commits on a branch?";
  const B = "b-lead";
  const store = doc([
    item("Writing small commits on every branch"),
    item("Likes small commits"),
    item("Writing notes for a branch"),
    item("Remember to write small commits", { mateId: B }),
    item("Small commits keep every branch reviewable", { mateId: B }),
    item("Branch names follow the ticket", { mateId: B }),
  ]);
  const decision = () => recallDecision({ doc: store, mateId: MATE, mateIds: [MATE, B], message: MESSAGE, now: NOW, mode: "automatic" });

  it("keeps a trace for each Mono it read, counting only that Mono's memories", () => {
    const turn = decision();
    recordRecall(turn, NOW);
    const own = lastRecallFor(MATE)!;
    const other = lastRecallFor(B)!;
    const mine = turn.candidates.filter((candidate) => candidate.mateId === MATE);
    const theirs = turn.candidates.filter((candidate) => candidate.mateId === B);
    expect(own.picked).toBe(mine.filter((candidate) => candidate.picked).length);
    expect(other.picked).toBe(theirs.filter((candidate) => candidate.picked).length);
    expect(own.picked + other.picked).toBe(turn.picked.length);
    expect(own.skipped).toBe(mine.length - own.picked);
    expect(other.skipped).toBe(theirs.length - other.picked);
  });

  it("says the Mono that lost its line to another Mono was held back, not picked", () => {
    recordRecall(decision(), NOW);
    const held = [lastRecallFor(MATE)!, lastRecallFor(B)!].flatMap((trace) => trace.reasons.map((reason) => reason.label));
    expect(held).toContain("over the three for this turn");
  });

  it("makes the Mono the turn belongs to the latest", () => {
    recordRecall(decision(), NOW);
    expect(latestRecall()!.mateId).toBe(MATE);
  });

  it("gives every Mono the same words when the whole turn was stopped", () => {
    recordRecall(
      recallDecision({ doc: store, mateId: MATE, mateIds: [MATE, B], message: "hi there", now: NOW, mode: "automatic" }),
      NOW,
    );
    expect(recallSummary(lastRecallFor(B)!)).toBe("Nothing was recalled: the message was a greeting.");
    expect(recallSummary(lastRecallFor(MATE)!)).toBe("Nothing was recalled: the message was a greeting.");
  });
});

