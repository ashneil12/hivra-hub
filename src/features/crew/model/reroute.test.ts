import { describe, expect, it } from "vitest";
import { decide, type Attempt } from "./reroute";
import type { Presence } from "./resolve";

const signed = (...clis: string[]): Presence[] => clis.map((cli) => ({ cli, installed: true, signedIn: true }));

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
    expect(second.reason).toBe("No other worker can take it");
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
    expect(twice.reason).toBe("The retry budget is spent");
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
    expect(stuck.reason).toBe("No other worker can take it");
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

describe("fallback order and the lock", () => {
  it("walks the person's fallback order, and an empty policy still names the account", () => {
    const ordered = failure({
      present: signed("claude", "codex", "grok"),
      policy: { lockDefault: false, neverUse: [], fallback: ["grok", "codex"] },
    });
    expect(ordered.action).toBe("reroute");
    if (ordered.action === "reroute") expect(ordered.to).toBe("grok");
    expect(ordered.reason).toBe("Claude Code can't take it, so this uses Grok.");
    expect(ordered.skipped).toEqual([]);
    const plain = failure();
    expect(plain.action).toBe("reroute");
    if (plain.action === "reroute") expect(plain.to).toBe("codex");
    expect(plain.reason).toBe("the account can't take it");
  });

  it("skips a banned entry, one that is not signed in, and one that is not installed", () => {
    const moved = failure({
      present: [
        { cli: "claude", installed: true, signedIn: true },
        { cli: "codex", installed: true, signedIn: true },
        { cli: "cursor", installed: true, signedIn: false },
        { cli: "grok", installed: true, signedIn: true },
      ],
      policy: { lockDefault: false, neverUse: ["codex"], fallback: ["codex", "cursor", "pi", "grok", "nope\ncli"] },
    });
    expect(moved.action).toBe("reroute");
    if (moved.action === "reroute") expect(moved.to).toBe("grok");
    expect(moved.reason).toBe(
      "Codex is on Never use, so it was skipped. Cursor isn't signed in, so it was skipped. Pi isn't installed here, so it was skipped. Claude Code can't take it, so this uses Grok.",
    );
    expect(moved.skipped.map((row) => row.outcome)).toEqual(["skipped", "skipped", "skipped"]);
    expect(moved.skipped.map((row) => row.errorClass)).toEqual([
      "Codex is on Never use, so it was skipped.",
      "Cursor isn't signed in, so it was skipped.",
      "Pi isn't installed here, so it was skipped.",
    ]);
  });

  it("does not leave the fallback list for a signed-in CLI that was not listed", () => {
    const stuck = failure({
      present: signed("claude", "codex"),
      policy: { fallback: ["grok"] },
    });
    expect(stuck.action).toBe("first-mate");
    expect(stuck.reason).toBe("Grok isn't installed here, so it was skipped. No other worker can take it");
  });

  it("a ban on the presence walk is not silent", () => {
    const moved = failure({
      present: signed("claude", "codex", "grok"),
      policy: { neverUse: ["codex"] },
    });
    expect(moved.action).toBe("reroute");
    if (moved.action === "reroute") expect(moved.to).toBe("grok");
    expect(moved.reason).toBe("Codex is on Never use, so it was skipped. Claude Code can't take it, so this uses Grok.");
    const itself = failure({
      present: signed("claude", "grok"),
      policy: { neverUse: ["claude"] },
    });
    expect(itself.reason).toBe("Claude Code is on Never use, so it was skipped. Claude Code can't take it, so this uses Grok.");
    const repeated = failure({
      present: signed("claude", "grok"),
      policy: { neverUse: ["claude"] },
      ledger: itself.skipped,
    });
    expect(repeated.skipped.map((row) => row.errorClass)).toEqual(["Claude Code is on Never use, so it was skipped."]);
  });

  it("the lock pauses on a known reset, and wakes the first mate when there is none", () => {
    const paused = failure({
      errorClass: "quota",
      resetsAt: 5_000,
      now: 1_000,
      present: signed("claude", "codex"),
      policy: { lockDefault: true, neverUse: ["cursor"], fallback: ["codex"] },
    });
    expect(paused.action).toBe("pause");
    if (paused.action === "pause") expect(paused.until).toBe(5_000);
    expect(paused.reason).toBe("Always use my default is on, so another CLI was not used.");
    expect(paused.attempt.outcome).toBe("paused");
    const woken = failure({
      errorClass: "quota",
      present: signed("claude", "codex"),
      policy: { lockDefault: true },
    });
    expect(woken.action).toBe("first-mate");
    expect(woken.reason).toBe("Always use my default is on, so another CLI was not used.");
    const alone = failure({
      errorClass: "usage_limit",
      resetsAt: 5_000,
      now: 1_000,
      present: signed("claude"),
      policy: { lockDefault: true },
    });
    expect(alone.action).toBe("pause");
    expect(alone.reason).toBe("Waiting for a usage limit to reset");
    const due = failure({
      errorClass: "usage_limit",
      resetsAt: 1_000,
      now: 1_000,
      present: signed("claude", "codex"),
      policy: { lockDefault: true },
    });
    expect(due.action).toBe("resume");
    expect(due.reason).toBe("The usage limit has reset");
  });

  it("a timeout still retries the same CLI while the lock is on", () => {
    const again = failure({ errorClass: "timeout", policy: { lockDefault: true }, present: signed("claude", "codex") });
    expect(again.action).toBe("again");
    expect(again.reason).toBe("the CLI didn't answer");
  });
});
