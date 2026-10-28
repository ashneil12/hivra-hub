import { describe, expect, it } from "vitest";
import { systemWindowTitle } from "./windowTitle";

describe("The window title while the hub shows its own view (r61, PM's r60 G2)", () => {
  it("names New project while a draft is open, whatever workspace tab sits hidden under it", () => {
    const hivra = systemWindowTitle("Replicate boat.dev", "/Users/ash/Projects/Hivra-public-canary", "MonoCode", "New project");
    expect(hivra).toBe("New project — MonoCode");
    expect(hivra).not.toContain("Hivra");
    // The workspace underneath changing (a background chat, a tab closing) doesn't rename the window.
    expect(systemWindowTitle("Perform a", "/Users/ash/Projects/other", "MonoCode", "New project")).toBe(hivra);
  });

  it("keeps the workspace's name when no hub view covers it", () => {
    expect(systemWindowTitle("Fix footer", "/Users/ash/Projects/Hivra-public-canary", "MonoCode")).toBe("Fix footer — Hivra-public-canary — MonoCode");
    expect(systemWindowTitle("", "/Users/ash/Projects/hivra", "MonoCode")).toBe("hivra — MonoCode");
    expect(systemWindowTitle("", "", "MonoCode")).toBe("MonoCode");
  });
});
