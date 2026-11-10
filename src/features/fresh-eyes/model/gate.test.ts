import { describe, expect, it } from "vitest";
import { readSetting } from "./setting";
import { memoryStorage, putReview, settingFor, writeSetting } from "./store";
import {
  firstMateMayAccept,
  freshEyesLine,
  mayLaunchBuilders,
  reviewBeforeCrew,
  type FreshEyesDeps,
} from "./gate";
import { ReviewerTimeout, type ReviewerPort } from "./review";

const PLAN = "Add a save button. Done when a reload keeps the note.";

function reviewers(text: string | Error, seen: { history: readonly [][]; models: (string | null)[] }): ReviewerPort {
  return {
    ask: async (turn) => {
      seen.history.push(turn.history);
      seen.models.push(turn.model);
      if (text instanceof Error) throw text;
      return text;
    },
  };
}

function deps(storage: ReturnType<typeof memoryStorage>, port?: ReviewerPort, extra: Partial<FreshEyesDeps> = {}): FreshEyesDeps {
  return { storage, ...(port ? { port } : {}), ...extra };
}

describe("fresh-eyes gate", () => {
  it("lets builders start when the setting is off", async () => {
    const storage = memoryStorage();
    expect(settingFor("/tmp/app", storage).enabled).toBe(false);
    expect(mayLaunchBuilders(readSetting(undefined), null)).toBe(true);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    const result = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: No.\nBREAK: No.", seen)),
    );
    expect(result.hold).toBe(false);
    expect(seen.history).toEqual([]);
  });

  it("holds builders until the person approves, and a clean review stays held without auto-accept", async () => {
    const storage = memoryStorage();
    await writeSetting("/tmp/app", { enabled: true }, storage);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    const asked: { question: string; options: string[]; recommended?: string }[] = [];
    const held = await reviewBeforeCrew(
      {
        project: "/tmp/app",
        requestId: "r1",
        plan: PLAN,
        ownerSession: "lead",
        route: { cli: "claude", model: "claude-opus-5-5", effort: "high" },
      },
      deps(storage, reviewers("", seen), {
        ask: async (input) => {
          asked.push({ question: input.question, options: input.options, recommended: input.recommended });
          return {};
        },
      }),
    );
    expect(held.hold).toBe(true);
    expect(held.why).toBe("Fresh-eyes review: waiting on you");
    expect(seen.history).toEqual([[], []]);
    expect(seen.models).toEqual(["claude-haiku-4-5", "claude-haiku-4-5"]);
    expect(asked).toEqual([
      {
        question: "Fresh-eyes review: waiting on you",
        options: ["Approve", "Edit plan", "Skip once"],
        recommended: "Approve",
      },
    ]);
    expect(mayLaunchBuilders(settingFor("/tmp/app", storage), null)).toBe(false);

    const again = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: Late.\nBREAK: Late.", seen), {
        lookup: async () => ({ state: "answered", answer: "Approve" }),
      }),
    );
    expect(again.hold).toBe(false);
    expect(again.why).toBe("Fresh-eyes review: cleared");
    expect(seen.models).toHaveLength(2);
  });

  it("lets the first mate accept only a clean review, and only when that is allowed", () => {
    const on = readSetting({ enabled: true, autoAcceptClean: true });
    const off = readSetting({ enabled: true });
    const clean = { status: "cleared" as const, findings: [], failed: [], retry: false };
    expect(firstMateMayAccept(on, clean)).toBe(true);
    expect(firstMateMayAccept(off, clean)).toBe(false);
    expect(
      firstMateMayAccept(on, {
        status: "findings",
        findings: [{ persona: "readiness", summary: "Missing", break: "It fails" }],
        failed: [],
        retry: false,
      }),
    ).toBe(false);
  });

  it("auto-accepts a clean review when the person allowed it, and still holds a finding", async () => {
    const storage = memoryStorage();
    await writeSetting("/tmp/app", { enabled: true, autoAcceptClean: true }, storage);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    const clean = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "clean", plan: PLAN, ownerSession: "lead", actor: "first-mate" },
      deps(storage, reviewers("", seen)),
    );
    expect(clean).toEqual({ hold: false, why: "Fresh-eyes review: cleared" });

    const found = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "found", plan: PLAN, ownerSession: "lead", actor: "first-mate" },
      deps(storage, reviewers("FINDING: The button has no name.\nBREAK: The person cannot find it.", seen)),
    );
    expect(found.hold).toBe(true);
    expect(found.why).toBe("Fresh-eyes review: 1 finding, waiting on you");
  });

  it("skips once for this plan only", async () => {
    const storage = memoryStorage();
    await writeSetting("/tmp/app", { enabled: true }, storage);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: No done line.\nBREAK: It never ends.", seen)),
    );
    const skipped = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("", seen), { lookup: async () => ({ answer: "Skip once" }) }),
    );
    expect(skipped.hold).toBe(false);
    expect(skipped.why).toBe("Fresh-eyes review: skipped once");
    expect(settingFor("/tmp/app", storage).enabled).toBe(true);

    const next = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r2", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: Still open.\nBREAK: The next plan was not reviewed.", seen)),
    );
    expect(next.hold).toBe(true);
    expect(next.why).toBe("Fresh-eyes review: 1 finding, waiting on you");
  });

  it("holds while the person is editing the plan", async () => {
    const storage = memoryStorage();
    await writeSetting("/tmp/app", { enabled: true }, storage);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: No done line.\nBREAK: It never ends.", seen)),
    );
    const editing = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("", seen), { lookup: async () => ({ answer: "Edit plan" }) }),
    );
    expect(editing.hold).toBe(true);
    const again = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "r1", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("FINDING: Changed.\nBREAK: Still open.", seen)),
    );
    expect(again.hold).toBe(true);
    expect(seen.models).toHaveLength(2);
  });

  it("does not start on an empty plan, and a timeout is not the end", async () => {
    const storage = memoryStorage();
    await writeSetting("/tmp/app", { enabled: true }, storage);
    const seen = { history: [] as readonly [][], models: [] as (string | null)[] };
    const empty = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "empty", plan: " \n ", ownerSession: "lead" },
      deps(storage, reviewers("", seen)),
    );
    expect(empty.hold).toBe(true);
    expect(seen.history).toEqual([]);

    const timed = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "slow", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers(new ReviewerTimeout(), seen)),
    );
    expect(timed.hold).toBe(true);
    const retried = await reviewBeforeCrew(
      { project: "/tmp/app", requestId: "slow", plan: PLAN, ownerSession: "lead" },
      deps(storage, reviewers("", seen)),
    );
    expect(retried.why).toBe("Fresh-eyes review: waiting on you");
    expect(seen.models.length).toBeGreaterThan(2);
  });

  it("drops a late write when a newer review is already stored", async () => {
    const storage = memoryStorage();
    const first = await putReview(
      {
        project: "/tmp/app",
        requestId: "r1",
        revision: 0,
        status: "pending",
        findings: [{ persona: "readiness", summary: "Newer", break: "Kept" }],
        failed: [],
        retry: false,
        asked: false,
        plan: PLAN,
      },
      0,
      storage,
    );
    expect(first.ok).toBe(true);
    const late = await putReview(
      {
        project: "/tmp/app",
        requestId: "r1",
        revision: 0,
        status: "approved",
        findings: [],
        failed: [],
        retry: false,
        asked: false,
        plan: PLAN,
      },
      0,
      storage,
    );
    expect(late.ok).toBe(false);
    expect(late.current?.status).toBe("pending");
    expect(late.current?.findings[0]?.summary).toBe("Newer");
  });

  it("says how many findings are waiting", () => {
    expect(freshEyesLine({ enabled: false, findings: 2 })).toBe(null);
    expect(freshEyesLine({ enabled: true, status: "pending", findings: 2 })).toBe(
      "Fresh-eyes review: 2 findings, waiting on you",
    );
    expect(freshEyesLine({ enabled: true, status: "approved", findings: 0 })).toBe("Fresh-eyes review: cleared");
    expect(freshEyesLine({ enabled: true, status: "pending", findings: 2 })).not.toMatch(/[—–]/);
  });
});
