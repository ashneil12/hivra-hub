import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { Decision } from "../../firstmate/model/steering";
import type { NeedsItem } from "../../needs/model/needsYou";
import { CATCH_UP_FIRST_LOOKBACK_MS, CATCH_UP_ROWS, answeredByOwner, buildCatchUp, catchUpBlock, catchUpNote, catchUpSince, catchUpSummary, catchUpText } from "./catchUp";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const projects = [
  { id: "exo", name: "EXO" },
  { id: "hivra", name: "Hivra" },
];

function job(id: string, over: Partial<Delegation>): Delegation {
  return { id, title: `Example: ${id}`, project: "exo", state: "completed", status: "done", childSession: `chat-${id}`, createdAt: NOW - 90 * MIN, updatedAt: NOW - 30 * MIN, settledAt: NOW - 30 * MIN, ...over } as Delegation;
}

function decision(key: string, over: Partial<Decision>): Decision {
  return { project: "exo", decisionKey: key, question: `Example: ${key}?`, options: ["Yes", "No"], recommended: "Yes", state: "answered", answer: "Yes", answeredBy: "captain:chief", answeredAt: NOW - 20 * MIN, ...over } as Decision;
}

const need = (key: string, over: Partial<NeedsItem> = {}): NeedsItem => ({ key, kind: "question", projectId: "hivra", who: "Hivra lead", at: NOW - 5 * MIN, sentence: `Example: ${key}?`, actions: [], ...over }) as NeedsItem;

const input = (over: Partial<Parameters<typeof buildCatchUp>[0]> = {}) => ({ rows: [], decisions: [], needs: [], projects, since: NOW - 60 * MIN, now: NOW, ...over });

describe("catch-up", () => {
  it("lists only the jobs that finished or stopped inside the window, newest first", () => {
    const doc = buildCatchUp(
      input({
        rows: [
          job("older", { settledAt: NOW - 50 * MIN, result: "Example: merged.\nMore detail." }),
          job("newer", { settledAt: NOW - 10 * MIN }),
          job("before", { settledAt: NOW - 61 * MIN }),
          job("stopped", { state: "failed", status: "failed", settledAt: NOW - 40 * MIN, error: "Example: tests failed" }),
          job("running", { state: "running", status: "working", settledAt: null }),
          job("waiting", { state: "running", status: "needs-you", settledAt: null }),
          // A failed job that waits on him is in Needs you, not in Finished.
          job("yours", { state: "failed", status: "needs-you", settledAt: NOW - 5 * MIN }),
        ],
      }),
    );
    expect(doc.finished.map((row) => row.id)).toEqual(["newer", "stopped", "older"]);
    expect(doc.finished[1]).toMatchObject({ ok: false, line: "Example: tests failed", project: "EXO", chat: "chat-stopped" });
    expect(doc.finished[2]).toMatchObject({ ok: true, line: "Example: merged." });
    expect(doc.running).toBe(3);
  });

  it("counts a decision as decided for him only when someone else answered it, inside the window", () => {
    expect(answeredByOwner("person")).toBe(true);
    expect(answeredByOwner("user")).toBe(true);
    expect(answeredByOwner("chat:abc")).toBe(true);
    expect(answeredByOwner(null)).toBe(true);
    expect(answeredByOwner("captain:chief")).toBe(false);
    const doc = buildCatchUp(
      input({
        decisions: [
          decision("by-chief", { answerReason: "Example: your standing answer" }),
          decision("by-ash", { answeredBy: "person" }),
          decision("typed", { answeredBy: "chat:one" }),
          decision("too-old", { answeredAt: NOW - 2 * 60 * MIN }),
          decision("open", { state: "open", answer: null, answeredBy: null, answeredAt: null }),
          decision("elsewhere", { project: "gone", answeredBy: "note:lead" }),
        ],
      }),
    );
    expect(doc.decided.map((row) => row.question)).toEqual(["Example: by-chief?", "Example: elsewhere?"]);
    expect(doc.decided[0]).toMatchObject({ project: "EXO", answer: "Yes", why: "Example: your standing answer" });
    // A project the app no longer has is not named.
    expect(doc.decided[1].project).toBeUndefined();
  });

  it("carries what needs him now, whenever it was asked, and caps each list with a count of the rest", () => {
    const needs = Array.from({ length: CATCH_UP_ROWS + 3 }, (_, index) => need(`n${index}`, { at: NOW - 3 * 24 * 60 * MIN }));
    const doc = buildCatchUp(input({ needs }));
    expect(doc.needs).toHaveLength(CATCH_UP_ROWS);
    expect(doc.needsMore).toBe(3);
    expect(doc.needs[0]).toMatchObject({ project: "Hivra", who: "Hivra lead", sentence: "Example: n0?" });
    expect(catchUpText(doc)).toContain("- and 3 more in Needs you");
  });

  it("sums itself in one line, and says so when nothing came back", () => {
    const full = buildCatchUp(input({ rows: [job("a", {}), job("b", {}), job("c", { state: "running", status: "working", settledAt: null })], decisions: [decision("d", {})], needs: [need("n")] }));
    expect(catchUpSummary(full)).toBe("2 jobs finished, 1 decided for you, 1 needs you, 1 still running.");
    const quiet = buildCatchUp(input());
    expect(catchUpSummary(quiet)).toBe("Nothing new came back: nothing needs you, nothing running.");
    expect(catchUpText(quiet)).toBe("Nothing new came back: nothing needs you, nothing running.");
  });

  it("writes the same card as plain words for a copy and for the Chief of Staff", () => {
    const doc = buildCatchUp(input({ rows: [job("stopped", { state: "failed", status: "failed", error: "Example: tests failed" })], decisions: [decision("font", { answerReason: "Example: matches the app" })], needs: [need("headline")] }));
    expect(catchUpText(doc).split("\n")).toEqual([
      "1 job finished, 1 decided for you, 1 needs you, nothing running.",
      "Finished:",
      "- EXO: Example: stopped (stopped). Example: tests failed",
      "Decided for you:",
      "- EXO: Example: font? Answer: Yes (Example: matches the app)",
      "Needs you:",
      "- Hivra: Example: headline?",
    ]);
  });

  it("starts each catch-up where the last one in the chat ended, and a day back the first time", () => {
    expect(catchUpSince([], NOW)).toBe(NOW - CATCH_UP_FIRST_LOOKBACK_MS);
    const first = catchUpBlock(buildCatchUp(input({ now: NOW - 30 * MIN })));
    const blocks = [{ catchUp: undefined }, first, { catchUp: undefined }];
    expect(catchUpSince(blocks, NOW)).toBe(NOW - 30 * MIN);
    // A job that finished before the last card is not told twice; one after it is.
    const next = buildCatchUp(input({ since: catchUpSince(blocks, NOW), rows: [job("told", { settledAt: NOW - 40 * MIN }), job("fresh", { settledAt: NOW - 10 * MIN })] }));
    expect(next.finished.map((row) => row.id)).toEqual(["fresh"]);
  });

  it("is its own app block, with its record on it", () => {
    const block = catchUpBlock(buildCatchUp(input({ needs: [need("n")] })));
    expect(block).toMatchObject({ id: `catch-up-${NOW}`, role: "system", text: "Nothing new came back: 1 needs you, nothing running.\nNeeds you:\n- Hivra: Example: n?" });
    expect(block.catchUp?.at).toBe(NOW);
  });

  it("tells the Chief of Staff what he was shown since its last reply, and nothing older", () => {
    const old = catchUpBlock(buildCatchUp(input({ now: NOW - 50 * MIN, needs: [need("old")] })));
    const shown = catchUpBlock(buildCatchUp(input({ needs: [need("new")] })));
    const reply = { role: "assistant" as const, text: "Example: done." };
    const note = catchUpNote([old, reply, shown, { role: "user" as const, text: "Example: do the first one" }]);
    expect(note).toContain("<shown_to_ash>");
    expect(note).toContain("Example: new?");
    expect(note).not.toContain("Example: old?");
    expect(catchUpNote([old, reply, { role: "user" as const, text: "Example: hello" }])).toBeUndefined();
  });
});
