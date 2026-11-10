// Hivra WP-172: the Tauri side of a fan-out's checkpoint. The rows come back as the app wrote them; a damaged one is
// read as none, so a resume never starts anything on its strength.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { createCheckpoint } from "../model/fanoutCheckpoint";
import { tauriFanoutCheckpoints, windowHolder } from "./fanoutCheckpointStore";

const cp = createCheckpoint({
  id: "plan-1",
  owner: "chat-1",
  waves: [["api"]],
  tasks: [{ name: "api", wave: 1, input: { intent: "API", brief: "b", goal: "g" } }],
  now: 5,
});

describe("tauriFanoutCheckpoints", () => {
  beforeEach(() => invoke.mockReset());

  it("saves a checkpoint under its owner with its id and revision", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(tauriFanoutCheckpoints.save("chat-1", cp)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("fanout_checkpoint_save", {
      owner: "chat-1",
      id: "plan-1",
      revision: 1,
      body: cp,
    });
  });

  it("lists only the checkpoints it can read, and drops a damaged one", async () => {
    invoke.mockResolvedValueOnce([cp, { id: "bad", version: 9 }, "text", null]);
    const listed = await tauriFanoutCheckpoints.list("chat-1");
    expect(invoke).toHaveBeenCalledWith("fanout_checkpoint_list", { owner: "chat-1" });
    expect(listed).toEqual([cp]);
  });

  it("reads a list that is not an array as empty", async () => {
    invoke.mockResolvedValueOnce({ not: "a list" });
    await expect(tauriFanoutCheckpoints.list("chat-1")).resolves.toEqual([]);
  });

  it("removes one plan of one owner", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(tauriFanoutCheckpoints.remove("chat-1", "plan-1")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("fanout_checkpoint_remove", { owner: "chat-1", id: "plan-1" });
  });

  it("takes, renews and releases a plan's lease for this window", async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(tauriFanoutCheckpoints.acquire("chat-1", "plan-1", "window-x")).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("fanout_lease_acquire", { owner: "chat-1", id: "plan-1", holder: "window-x" });
    invoke.mockResolvedValueOnce(false);
    await expect(tauriFanoutCheckpoints.renew("chat-1", "plan-1", "window-x")).resolves.toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("fanout_lease_renew", { owner: "chat-1", id: "plan-1", holder: "window-x" });
    invoke.mockResolvedValueOnce(true);
    await expect(tauriFanoutCheckpoints.release("chat-1", "plan-1", "window-x")).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("fanout_lease_release", { owner: "chat-1", id: "plan-1", holder: "window-x" });
  });

  it("gives each window its own holder id, the same for the window's life", () => {
    expect(windowHolder()).toMatch(/^[A-Za-z0-9-]{8,}$/);
    expect(windowHolder()).toBe(windowHolder());
  });
});
