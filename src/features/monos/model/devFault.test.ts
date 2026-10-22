import { describe, expect, it } from "vitest";
import { faultedOutcome, takeWorkerFault } from "./devFault";

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
    expect(faultedOutcome(done, "Test fault: x")).toEqual({ status: "failed", text: "all good", error: "Test fault: x" });
    expect(faultedOutcome({ status: "failed", text: "", error: "boom" }, "Test fault: x").error).toBe("Test fault: x");
    const stopped = { status: "cancelled" as const, text: "" };
    expect(faultedOutcome(stopped, "Test fault: x")).toBe(stopped);
  });
});
