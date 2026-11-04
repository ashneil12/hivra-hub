import { afterEach, describe, expect, it, vi } from "vitest";
import { tauriDelegations, type Delegation } from "../../monos/model/delegations";
import { loadCrewDelegations, mergeDelegations } from "./load";

function row(id: string, updatedAt: number): Delegation {
  return { id, updatedAt } as Delegation;
}

describe("every open delegation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an open row older than the newest 200, and a finished row from recent", () => {
    const open = Array.from({ length: 201 }, (_, index) => row(`open-${index}`, index));
    const recent = open.slice(1).map((item) => row(item.id, (item.updatedAt ?? 0) + 1));
    recent.push(row("done-1", 500));
    const merged = mergeDelegations(open, recent);
    expect(merged.map((item) => item.id)).toContain("open-0");
    expect(merged.map((item) => item.id)).toContain("done-1");
    expect(merged.find((item) => item.id === "open-1")?.updatedAt).toBe(2);
    expect(merged.filter((item) => item.id === "open-1")).toHaveLength(1);
  });

  it("ignores a blank id and lets the newer write win", () => {
    const merged = mergeDelegations(
      [row("", 1), row("a", 1)],
      [row("a", 2), { id: "a", updatedAt: 0 } as Delegation],
    );
    expect(merged).toEqual([row("a", 2)]);
  });

  it("fails the load when the open list cannot be read, even if recent would answer", async () => {
    vi.spyOn(tauriDelegations, "listOpen").mockRejectedValue(new Error("down"));
    vi.spyOn(tauriDelegations, "recent").mockResolvedValue([row("done-1", 1)]);
    expect(await loadCrewDelegations()).toEqual({ ok: false });
  });

  it("still returns the open rows when recent times out", async () => {
    vi.spyOn(tauriDelegations, "listOpen").mockResolvedValue([row("open-0", 1)]);
    vi.spyOn(tauriDelegations, "recent").mockRejectedValue(new Error("slow"));
    expect(await loadCrewDelegations()).toEqual({ ok: true, value: [row("open-0", 1)] });
  });
});
