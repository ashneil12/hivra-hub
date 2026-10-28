import { describe, expect, it } from "vitest";
import { viewAfterRemoval } from "./sessionWorkspaceLifecycle";

describe("A session leaving the window moves Ash only when he removed it (r61, PM's r60 D5/C3)", () => {
  const removal = { activeTabId: "tab-replicate-boat-dev", windowEmptied: false };

  it("a group room letting go of its session, or the CLI deleting one, leaves the view where Ash is", () => {
    expect(viewAfterRemoval("delete", "app", removal, "tab-hivra-launch")).toEqual({ activeTabId: "tab-replicate-boat-dev", reveal: false, home: null });
    expect(viewAfterRemoval("archive", "cli", removal, "tab-hivra-launch").reveal).toBe(false);
    // Even when it empties the window, background work never takes him home.
    expect(viewAfterRemoval("delete", "app", { ...removal, windowEmptied: true }, "tab-hivra-launch").home).toBeNull();
  });

  it("Ash's own archive or delete shows the next tab, and the window's home when it was the last", () => {
    expect(viewAfterRemoval("archive", "ui", removal, "tab-hivra-launch")).toEqual({ activeTabId: "tab-replicate-boat-dev", reveal: true, home: null });
    expect(viewAfterRemoval("delete", "ui", { ...removal, windowEmptied: true }, "tab-hivra-launch").home).toEqual({ project: "", item: "" });
  });

  it("a removal that keeps the same tab changes nothing", () => {
    expect(viewAfterRemoval("archive", "ui", removal, "tab-replicate-boat-dev").activeTabId).toBeNull();
  });
});
