// WP-157: the learn screen's real ports hand work log edits to the retro store, and keep every
// other proposal on the path it had.
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { learnPorts } from "./learnHost";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const store = vi.hoisted(() => ({
  listStaged: vi.fn(),
  acceptStaged: vi.fn(),
  rejectStaged: vi.fn(),
}));
vi.mock("../../workLog/model/retroStore", () => store);

describe("learnPorts and the work log edits", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    store.listStaged.mockReset().mockResolvedValue([
      { id: "retro:abc", title: "Work sent back", diff: "+ x", quotes: [] },
    ]);
    store.acceptStaged.mockReset().mockResolvedValue(true);
    store.rejectStaged.mockReset().mockResolvedValue(true);
  });

  it("lists the waiting edits and reads only", async () => {
    const shown = await learnPorts().staged!();
    expect(shown.map((row) => row.id)).toEqual(["retro:abc"]);
    expect(store.acceptStaged).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accept and reject of a work log edit go to the retro store", async () => {
    const ports = learnPorts();
    await expect(ports.accept("retro:abc")).resolves.toBe(true);
    expect(store.acceptStaged).toHaveBeenCalledWith("retro:abc");
    await expect(ports.reject("retro:abc")).resolves.toBe(true);
    expect(store.rejectStaged).toHaveBeenCalledWith("retro:abc");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a refusal from the retro store reaches the screen as it was said", async () => {
    store.acceptStaged.mockRejectedValue(new Error("Opinions is full. Remove or merge something there first."));
    await expect(learnPorts().accept("retro:abc")).rejects.toThrow("Opinions is full.");
  });

  it("any other id still takes the learn from chats path, and an unknown one is refused", async () => {
    const ports = learnPorts();
    await expect(ports.accept("opinions.md:gap-1")).resolves.toBe(false);
    await expect(ports.reject("opinions.md:gap-1")).resolves.toBe(false);
    expect(store.acceptStaged).not.toHaveBeenCalled();
    expect(store.rejectStaged).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
