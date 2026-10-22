import { describe, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import { FAULT_ERROR, FAULT_STOP_MS, faultedOutcome, faultedReply, faultStopper, takeWorkerFault, withoutTestMarker } from "./devFault";
import { monoSessionCompletionMessage, monoSessionCompletionResult } from "./monoSessionCompletion";

describe("dev fault (D5 scripted worker failure)", () => {
  it("is off unless the app side says this worker takes a fault", async () => {
    expect(await takeWorkerFault(async () => null)).toBeUndefined();
    expect(await takeWorkerFault(async () => "")).toBeUndefined();
    expect(await takeWorkerFault(async () => { throw new Error("no such command"); })).toBeUndefined();
    expect(await takeWorkerFault(async () => "Test fault: x")).toBe("Test fault: x");
  });

  it("turns a finished or failed turn into a plain failure, never a test marker, and never a stop", () => {
    const done = { status: "completed" as const, text: "all good" };
    expect(faultedOutcome(done, undefined)).toBe(done);
    expect(faultedOutcome(done, "Test fault: x")).toEqual({ status: "failed", text: "", error: "Stopped with an error." });
    expect(faultedOutcome({ status: "failed", text: "", error: "boom" }, "Test fault: x").error).toBe(FAULT_ERROR);
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
    expect(monoSessionCompletionResult(opts)).toMatchObject({ status: "failed", result: "", error: "Stopped with an error." });
    expect(JSON.stringify(monoSessionCompletionResult(opts)) + monoSessionCompletionMessage(opts).text).not.toMatch(/test|purpose|dev-faults/i);
    expect(monoSessionCompletionMessage(opts).text).not.toContain("README is tidy");
    // Not armed: the report goes through as always.
    expect(faultedReply(done, undefined)).toEqual({});
    expect(monoSessionCompletionResult({ ...options, session, outcome: done }).result).toContain("README is tidy");
  });

  // Critiquito on r30: the test text on Today and Being built gave blind tests away.
  it("an older build's stored test-fault text reads as a plain failure; anything else is left alone", () => {
    expect(withoutTestMarker("Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers).")).toBe(FAULT_ERROR);
    expect(withoutTestMarker("Claude exited with code 1")).toBe("Claude exited with code 1");
    expect(withoutTestMarker(null)).toBeNull();
  });
});

describe("the fault's early stop (PM's D5 run, 22 Oct: armed 17:59, worker still running 18:09)", () => {
  function fakeTimers() {
    const pending = new Map<number, () => void>();
    let next = 0;
    return {
      pending,
      timers: {
        set: (run: () => void) => (pending.set(++next, run), next),
        clear: (handle: unknown) => void pending.delete(handle as number),
      },
      fire: () => {
        for (const [id, run] of [...pending]) {
          pending.delete(id);
          run();
        }
      },
    };
  }

  it("stops a faulted worker after it starts, and that cancelled turn reads as the failure", () => {
    const clock = fakeTimers();
    const stop = vi.fn();
    const fault = faultStopper(FAULT_ERROR, stop, clock.timers, FAULT_STOP_MS);
    fault.start();
    expect(stop).not.toHaveBeenCalled();
    clock.fire();
    expect(stop).toHaveBeenCalledTimes(1);
    const cancelled = { status: "cancelled", text: "half done" } as const;
    fault.done();
    expect(faultedOutcome(cancelled, FAULT_ERROR, fault.stopped())).toEqual({ status: "failed", text: "", error: FAULT_ERROR });
    expect(faultedReply(cancelled, FAULT_ERROR, fault.stopped())).toEqual({ reply: "" });
  });

  it("leaves a worker with no fault, an early end and Ash's own stop alone", () => {
    const clock = fakeTimers();
    const stop = vi.fn();
    const none = faultStopper(undefined, stop, clock.timers);
    none.start();
    expect(clock.pending.size).toBe(0);

    const ended = faultStopper(FAULT_ERROR, stop, clock.timers);
    ended.start();
    ended.done();
    clock.fire();
    expect(stop).not.toHaveBeenCalled();

    const cancelled = { status: "cancelled", text: "" } as const;
    expect(faultedOutcome(cancelled, FAULT_ERROR, ended.stopped())).toEqual(cancelled);
    expect(faultedReply(cancelled, FAULT_ERROR, ended.stopped())).toEqual({});
  });
});
