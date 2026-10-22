import { describe, expect, it } from "vitest";
import { newSession } from "../../sessions/model/session";
import { faultedOutcome, faultedReply, takeWorkerFault } from "./devFault";
import { monoSessionCompletionMessage, monoSessionCompletionResult } from "./monoSessionCompletion";

describe("dev fault (D5 scripted worker failure)", () => {
  it("is off unless the app side says this worker takes a fault", async () => {
    expect(await takeWorkerFault(async () => null)).toBeUndefined();
    expect(await takeWorkerFault(async () => "")).toBeUndefined();
    expect(await takeWorkerFault(async () => { throw new Error("no such command"); })).toBeUndefined();
    expect(await takeWorkerFault(async () => "Test fault: x")).toBe("Test fault: x");
  });

  it("turns a finished or failed turn into a failure with the test error, but never a stop", () => {
    const done = { status: "completed" as const, text: "all good" };
    expect(faultedOutcome(done, undefined)).toBe(done);
    expect(faultedOutcome(done, "Test fault: x")).toEqual({ status: "failed", text: "", error: "Test fault: x" });
    expect(faultedOutcome({ status: "failed", text: "", error: "boom" }, "Test fault: x").error).toBe("Test fault: x");
    const stopped = { status: "cancelled" as const, text: "" };
    expect(faultedOutcome(stopped, "Test fault: x")).toBe(stopped);
  });

  it("keeps the worker's report from its Lead: the Lead gets only a failed worker (PM's blind D5, 22 Oct)", () => {
    const options = { requestId: "app-lead-1", sessionId: "worker", project: "/code/hivra", prompt: "Tidy the README" };
    const session = newSession("claude", options.project);
    session.blocks = [
      { id: "u", role: "user", text: options.prompt, appRequestId: options.requestId },
      { id: "r", role: "assistant", text: "Done: the README is tidy and pushed." },
    ];
    const done = { status: "completed" as const, text: "Done: the README is tidy and pushed." };
    const fault = "Test fault: this worker was set to fail (dev-faults)";
    const opts = { ...options, session, outcome: faultedOutcome(done, fault), ...faultedReply(done, fault) };
    expect(monoSessionCompletionResult(opts)).toMatchObject({ status: "failed", result: "", error: fault });
    expect(monoSessionCompletionMessage(opts).text).not.toContain("README is tidy");
    // Not armed: the report goes through as always.
    expect(faultedReply(done, undefined)).toEqual({});
    expect(monoSessionCompletionResult({ ...options, session, outcome: done }).result).toContain("README is tidy");
  });
});
