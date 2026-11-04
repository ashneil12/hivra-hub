import { describe, expect, it } from "vitest";
import { decide, type Attempt } from "./reroute";
import type { Presence } from "./resolve";

const present: Presence[] = [
  { cli: "claude", installed: true, signedIn: true },
  { cli: "codex", installed: true, signedIn: true },
  { cli: "cursor", installed: true, signedIn: false },
  { cli: "pi", installed: false, signedIn: true },
];

function failure(partial: Partial<Parameters<typeof decide>[0]> = {}) {
  return decide({
    errorClass: "quota",
    now: 1_000,
    current: { cli: "claude", model: "opus", effort: "high" },
    present,
    ledger: [],
    ...partial,
  });
}

function rerouted(cli: string, to: string): Attempt {
  return { at: 1, cli, model: null, effort: null, errorClass: "quota", outcome: "rerouted", to };
}

describe("reroute", () => {
  it("moves an account failure to the next signed-in CLI, skipping ones already tried", () => {
    const first = failure();
    expect(first.action).toBe("reroute");
    if (first.action === "reroute") expect(first.to).toBe("codex");
    const second = failure({
      current: { cli: "codex" },
      ledger: [rerouted("claude", "codex")],
    });
    expect(second.action).toBe("first-mate");
    expect(second.reason).toBe("no other worker can take it");
  });

  it("never reroutes a task failure, and does not spend the budget on it", () => {
    const task = failure({ errorClass: "approval_denied", budget: 2 });
    expect(task.action).toBe("first-mate");
    expect(task.reason).toBe("the work failed");
    const after = failure({
      ledger: [{ ...task.attempt, outcome: "first-mate" }],
    });
    expect(after.action).toBe("reroute");
  });

  it("stops after the budget, which defaults to 2", () => {
    const once = failure({ ledger: [rerouted("claude", "codex")], current: { cli: "codex" }, present: [
      ...present,
      { cli: "hermes", installed: true, signedIn: true },
    ] });
    expect(once.action).toBe("reroute");
    const twice = failure({
      current: { cli: "hermes" },
      present: [...present, { cli: "hermes", installed: true, signedIn: true }, { cli: "devin", installed: true, signedIn: true }],
      ledger: [rerouted("claude", "codex"), { ...rerouted("codex", "hermes"), at: 2 }],
    });
    expect(twice.action).toBe("first-mate");
    expect(twice.reason).toBe("the retry budget is spent");
    expect(failure({ budget: 0 }).action).toBe("first-mate");
    expect(failure({ budget: true }).action).toBe("reroute");
    expect(failure({ budget: "abort" }).action).toBe("first-mate");
    expect(failure({ budget: "retry(1)", ledger: [rerouted("claude", "codex")], current: { cli: "codex" }, present: [
      ...present,
      { cli: "hermes", installed: true, signedIn: true },
    ] }).action).toBe("first-mate");
  });

  it("retries a timeout on the same CLI, and does not call that the work failing", () => {
    const again = failure({ errorClass: "timeout" });
    expect(again.action).toBe("again");
    expect(again.reason).toBe("the CLI didn't answer");
    const spent = failure({
      errorClass: "network_error",
      ledger: [
        { at: 1, cli: "claude", model: null, effort: null, errorClass: "timeout", outcome: "again" },
        { at: 2, cli: "claude", model: null, effort: null, errorClass: "timeout", outcome: "again" },
      ],
    });
    expect(spent.action).toBe("first-mate");
    expect(spent.reason).toBe("the CLI didn't answer");
  });
});

describe("pause then resume", () => {
  const alone: Presence[] = [{ cli: "claude", installed: true, signedIn: true }];

  it("pauses a usage limit when nothing else can take it, and resumes once the time has come", () => {
    const paused = failure({ errorClass: "usage_limit", resetsAt: 5_000, now: 1_000, present: alone });
    expect(paused.action).toBe("pause");
    if (paused.action === "pause") expect(paused.until).toBe(5_000);
    expect(paused.attempt.outcome).toBe("paused");
    const due = failure({ errorClass: "usage_limit", resetsAt: 5_000, now: 5_000, present: alone });
    expect(due.action).toBe("resume");
    const early = failure({
      errorClass: "usage_limit",
      resetsAt: 5_000,
      now: 4_999,
      present: alone,
      ledger: [paused.attempt],
    });
    expect(early.action).toBe("pause");
  });

  it("reroutes a usage limit when another CLI is signed in", () => {
    const moved = failure({ errorClass: "usage_limit", resetsAt: 5_000 });
    expect(moved.action).toBe("reroute");
    if (moved.action === "reroute") expect(moved.to).toBe("codex");
  });

  it("sends a usage limit with no reset and no other CLI to the first mate", () => {
    const stuck = failure({ errorClass: "usage_limit", present: alone });
    expect(stuck.action).toBe("first-mate");
    expect(stuck.reason).toBe("no other worker can take it");
  });

  it("a pause does not use up a reroute", () => {
    const paused = failure({ errorClass: "usage_limit", resetsAt: 5_000, present: alone });
    const later = failure({
      ledger: [paused.attempt],
      present,
    });
    expect(later.action).toBe("reroute");
  });
});
