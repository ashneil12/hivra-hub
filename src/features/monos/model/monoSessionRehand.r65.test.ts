// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { completionMessage, rehandLine, type MonoSessionCompletionResult } from "./monoSessionCompletion";

function failed(title: string, extra: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult {
  return {
    sessionId: `s-${title}`,
    project: "/Users/ash/Projects/hivra",
    title,
    status: "failed",
    originalPrompt: "brief",
    result: "",
    truncated: false,
    error: "Stopped with an error.",
    ...extra,
  };
}

describe("r65 #12: a worker that dies on a fault is re-handed once, then reported", () => {
  beforeEach(() => localStorage.clear());

  it("first failure: hand it to one fresh worker, don't do it yourself", () => {
    const line = rehandLine([failed("Wire Stripe checkout")]);
    expect(line).toContain("Hand Wire Stripe checkout to one fresh worker with the same brief (delegate_task), once");
    expect(line).toContain("don't do it yourself");
    expect(line).not.toContain("failed twice");
  });

  it("second failure of the same job: tell Ash, no third worker", () => {
    rehandLine([failed("Wire Stripe checkout")]);
    const again = rehandLine([failed("Wire  stripe checkout", { sessionId: "s-2" })]);
    expect(again).toContain("already failed once on a fresh worker");
    expect(again).toContain("tell Ash plainly that it failed twice");
    expect(again).not.toContain("Hand Wire");
    // After the report, a later new attempt starts the count again.
    expect(rehandLine([failed("Wire Stripe checkout")])).toContain("Hand Wire Stripe checkout");
  });

  it("an unretryable failure (credits, sign-in) is not re-handed", () => {
    expect(rehandLine([failed("Deploy", { retryable: false })])).toBe("");
  });

  it("completed or cancelled work adds nothing", () => {
    expect(rehandLine([failed("Docs", { status: "completed" }), failed("Old", { status: "cancelled" })])).toBe("");
  });

  it("the Lead's report turn carries the instruction", () => {
    const message = completionMessage("m1", [failed("Fix login page")]);
    expect(message.text).toContain("FAILED, not done: Fix login page");
    expect(message.text).toContain("Hand Fix login page to one fresh worker");
  });
});

it("does not hand a known usage-limit refusal to another worker on the same exhausted account", () => {
  expect(rehandLine([failed("Example: fix chat", {errorClass: "usage_limit", retryable: true})])).toBe("");
});
