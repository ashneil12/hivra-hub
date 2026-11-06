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
