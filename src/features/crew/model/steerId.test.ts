import { describe, expect, it } from "vitest";
import { steerRequestId } from "./steerId";

describe("steering request ids", () => {
  it("does not repeat an id the way a counter does after a reload", () => {
    const first = steerRequestId("worker");
    const second = steerRequestId("worker");
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/^crew-worker-\d+$/);
    expect(second).not.toMatch(/^crew-worker-\d+$/);
    expect(steerRequestId("worker 1", "same")).toBe(steerRequestId("worker-1", "same"));
  });

  it("rejects an empty nonce so two windows cannot both send crew-worker", () => {
    expect(() => steerRequestId("worker", "   ")).toThrow(/nonce/);
    expect(() => steerRequestId("worker", "!!!")).toThrow(/nonce/);
  });
});
