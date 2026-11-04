import { describe, expect, it, vi } from "vitest";
import type { DeliveryDeps, SteerMessage } from "../model/steering";
import { steeringDrain } from "./useSteering";

const pendingMessage = {
  id: "s-1",
  ownerSession: "fm",
  childSession: "w1",
  requestId: "r1",
  text: "go",
  mode: "auto",
  state: "pending",
  attempts: 0,
  heldAt: null,
  updatedAt: 0,
} as unknown as SteerMessage;

function deps(): DeliveryDeps {
  return {
    backend: {
      pending: vi.fn(async () => [pendingMessage]),
      settle: vi.fn(async () => ({ applied: true, message: null })),
    } as unknown as DeliveryDeps["backend"],
    chat: vi.fn(async () => ({ id: "w1", busy: false, blocks: [], queuedMessages: [], harness: "claude" }) as never),
    canSteer: () => true,
    submit: vi.fn(async () => true),
  };
}

describe("steeringDrain", () => {
  it("delivers in the main window", async () => {
    const d = deps();
    await steeringDrain(() => d, true)();
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it("never reads or submits in another window (New window, quick-session windows)", async () => {
    const d = deps();
    await steeringDrain(() => d, false)();
    expect(d.backend.pending).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
  });
});
