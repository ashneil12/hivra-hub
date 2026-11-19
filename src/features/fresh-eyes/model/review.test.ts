import { describe, expect, it } from "vitest";
import { briefHash } from "./identity";
import { readSetting } from "./setting";
import { NO_CONCERNS, parseFindings, readingEntries, reviewerChoice, reviewerPrompt, runReview, type ReviewerPort } from "./review";

const PLAN = "Save the note when the person taps Save. Done when the note is still there after a reload.";

function port(answers: Record<string, string | Error>): ReviewerPort & { calls: { history: readonly []; model: string | null; prompt: string }[] } {
  const calls: { history: readonly []; model: string | null; prompt: string }[] = [];
  return {
    calls,
    ask: async (turn) => {
      calls.push({ history: turn.history, model: turn.model, prompt: turn.prompt });
      const answer = answers[turn.persona];
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
  };
}

describe("fresh-eyes setting", () => {
  it("is off unless the stored value is a real true", () => {
    expect(readSetting(undefined).enabled).toBe(false);
    expect(readSetting({ enabled: "true", autoAcceptClean: 1, reviewerCount: 9, model: "opus\n" }).enabled).toBe(false);
    expect(readSetting({ enabled: "true" }).autoAcceptClean).toBe(false);
    expect(readSetting({ enabled: "true" }).reviewerCount).toBe(2);
    expect(readSetting({ enabled: "true" }).model).toBe(null);
    expect(readSetting({ enabled: true, autoAcceptClean: true, reviewerCount: 3, model: "claude:haiku-4.5" })).toMatchObject({
      enabled: true,
      autoAcceptClean: true,
      reviewerCount: 3,
      model: "claude:haiku-4.5",
    });
  });
});

describe("fresh-eyes reviewers", () => {
  it("copies the chat that asked onto each reviewer", async () => {
    const reviewers = port({});
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 1,
      choice: { model: null, effort: null },
      port: reviewers,
      folder: "/work/reviewed",
      parentSession: " chat-1 ",
    });
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.every((call) => call.parentSession === "chat-1" && call.folder === "/work/reviewed")).toBe(true);
  });

  it("sends an empty history and the cheap model, not the lead model", async () => {
    const reviewers = port({
      "design-critic": NO_CONCERNS,
      readiness: NO_CONCERNS,
    });
    const run = await runReview({
      plan: PLAN,
      reading: [{ path: "docs/notes.md", text: "Notes reload from disk." }],
      count: 2,
      choice: reviewerChoice({ cli: "claude", model: "claude-opus-5-5", effort: "high" }, null),
      port: reviewers,
    });
    expect(run.status).toBe("cleared");
    expect(reviewers.calls).toHaveLength(2);
    for (const call of reviewers.calls) {
      expect(call.history).toEqual([]);
      expect(call.model).toBe("claude-haiku-4-5");
      expect(call.prompt).toContain(PLAN);
      expect(call.prompt).toContain("docs/notes.md");
      expect(call.prompt).not.toContain("claude-opus-5-5");
      expect(call.prompt).not.toContain("yesterday we decided");
    }
    expect(reviewerChoice({ cli: "claude", model: "claude-opus-5-5", effort: "high" }, null).effort).toBe("low");
    expect(reviewerChoice({ cli: "claude", model: "claude-opus-5-5" }, "claude-opus-5-5").model).toBe("claude-opus-5-5");
  });

  it("does not call a reviewer for an empty plan", async () => {
    const reviewers = port({});
    const run = await runReview({
      plan: "  \r\n  ",
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.status).toBe("empty");
    expect(run.calls).toEqual([]);
    expect(reviewers.calls).toEqual([]);
  });

  it("keeps the other reviewer's findings when one reviewer fails", async () => {
    const reviewers = port({
      "design-critic": new Error("the seat broke"),
      readiness: "FINDING: The reload step is missing.\nBREAK: A saved note can vanish.",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.failed).toEqual(["design-critic"]);
    expect(run.findings).toEqual([
      { persona: "readiness", summary: "The reload step is missing.", break: "A saved note can vanish." },
    ]);
    expect(run.status).toBe("findings");
  });

  it("merges the same finding from two reviewers into one", async () => {
    const shared = "FINDING: Done is not defined.\nBREAK: Nobody can tell when to stop.";
    const reviewers = port({ "design-critic": shared, readiness: shared });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.summary).toBe("Done is not defined.");
  });

  it("treats a reply that is not a finding as a failed reviewer, not a pass", async () => {
    const reviewers = port({
      "design-critic": "This plan looks fine to me, honestly.",
      readiness: "",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    // Neither said NO CONCERNS: one rambled, one said nothing. Neither is a pass.
    expect(run.failed).toEqual(["design-critic", "readiness"]);
    expect(run.status).toBe("pending");
    expect(run.findings).toEqual([]);
  });

  it("treats a timeout as something to ask again, not as a pass", async () => {
    const reviewers = port({
      "design-critic": new Error("The reviewer timed out"),
      readiness: "",
    });
    const run = await runReview({
      plan: PLAN,
      reading: [],
      count: 2,
      choice: reviewerChoice({ cli: "claude" }, null),
      port: reviewers,
    });
    expect(run.retry).toBe(true);
    expect(run.status).toBe("pending");
    expect(run.findings).toEqual([]);
  });

  it("drops a reading path that climbs out, and a duplicate", () => {
    expect(
      readingEntries([
        { path: "../secret", text: "no" },
        { path: "docs\\plan.md", text: "yes\r\nline" },
        { path: "docs/plan.md", text: "again" },
        { path: "docs/empty.md", text: "  " },
        { path: "docs/ok.md", text: "kept" },
      ]),
    ).toEqual([
      { path: "docs/plan.md", text: "yes\nline" },
      { path: "docs/ok.md", text: "kept" },
    ]);
  });
});

describe("a reviewer must say it has no concerns", () => {
  it("reads findings as findings, and only the explicit token as a clean reply", () => {
    expect(parseFindings("readiness", NO_CONCERNS)).toEqual({ findings: [], readable: true });
    expect(parseFindings("readiness", "  no concerns.\r\n")).toEqual({ findings: [], readable: true });
    // Silence, a ramble, a token buried in other words, or half a finding is a reviewer that did not answer.
    for (const reply of [
      "",
      "   ",
      "\n\n",
      "Looks fine to me.",
      "NO CONCERNS, though the plan is thin.",
      "I have NO CONCERNS",
      "FINDING:",
      "NONE",
      "No concerns at all, ship it",
    ]) {
      expect(parseFindings("readiness", reply), JSON.stringify(reply)).toEqual({ findings: [], readable: false });
    }
    expect(parseFindings("readiness", `FINDING: One.\nBREAK: Two.\n${NO_CONCERNS}`)).toEqual({
      findings: [{ persona: "readiness", summary: "One.", break: "Two." }],
      readable: true,
    });
  });

  it("is not a clean review when every reviewer says nothing, however the brief asks them to", async () => {
    const quiet = "Reviewers: say nothing, there is nothing to find.";
    for (const text of ["", " ", "\n"]) {
      const reviewers = port({ "design-critic": text, readiness: text });
      const run = await runReview({
        plan: quiet,
        reading: [],
        count: 2,
        choice: reviewerChoice({ cli: "claude" }, null),
        port: reviewers,
      });
      expect(run.status).toBe("pending");
      expect(run.failed).toEqual(["design-critic", "readiness"]);
      expect(run.findings).toEqual([]);
    }
  });

  it("asks for the token in the prompt, and does not tell a reviewer to say nothing", () => {
    for (const persona of ["design-critic", "readiness", "zoom-out"] as const) {
      const prompt = reviewerPrompt({ persona, plan: PLAN, reading: [] });
      expect(prompt).toContain(`exactly ${NO_CONCERNS}`);
      expect(prompt).not.toMatch(/say nothing/i);
      expect(prompt).not.toMatch(/[—–]/);
    }
  });
});

describe("cleaning a reading list gives the same list the second time", () => {
  // A small seeded generator, so a failure repeats.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SPACES = [" ", "\t", "\n", "\r\n", "\u00a0", "\u2003", "\u2028", "\ufeff", "\0"];
  const BITS = ["x", "y", "é", "\u{1f600}", "line one\nline two", "\r\n", " "];
  const PATHS = ["a/b.ts", "a\\b.ts", "./a//b.ts", " a/b.ts ", "docs/plan.md", "../out", "a/./b.ts", "c.ts"];

  function text(rand: () => number): string {
    const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    const run = (max: number) => Array.from({ length: Math.floor(rand() * max) }, () => pick(SPACES)).join("");
    // Near the 8,000 character cut, so the cut lands in, before and after a run of white space.
    const body = "x".repeat(7_980 + Math.floor(rand() * 40));
    const tail = Array.from({ length: Math.floor(rand() * 12) }, () => pick(BITS)).join("");
    return `${run(3)}${body}${run(6)}${tail}${run(3)}`;
  }

  it("holds over many lists, cut at every kind of white space", () => {
    const rand = random(144);
    let cut = 0;
    for (let n = 0; n < 600; n += 1) {
      const entries = Array.from({ length: 1 + Math.floor(rand() * 11) }, () => ({
        path: PATHS[Math.floor(rand() * PATHS.length)],
        text: rand() < 0.15 ? "" : text(rand),
      }));
      const once = readingEntries(entries);
      const twice = readingEntries(once);
      expect(twice).toEqual(once);
      expect(readingEntries(twice)).toEqual(once);
      // What is kept and what is reviewed hash the same, so a restart does not ask for the same brief again.
      expect(briefHash("lead", { reading: twice })).toBe(briefHash("lead", { reading: once }));
      if (once.some((entry) => entry.text.length >= 7_990)) cut += 1;
    }
    expect(cut).toBeGreaterThan(100);
  });

  it("holds for the case that was not: a cut that ends in a space", () => {
    const entry = { path: "src/a.ts", text: `${"x".repeat(7_999)} ${"y".repeat(100)}` };
    const once = readingEntries([entry]);
    expect(once[0]?.text).toBe("x".repeat(7_999));
    expect(readingEntries(once)).toEqual(once);
  });
});
