import { describe, expect, it, vi } from "vitest";
import type { PaletteRow } from "./commandRegistry";
import { PALETTE_COMMANDS } from "./commandRegistry";
import {
  PALETTE_APP_ACTIONS,
  PALETTE_TAB_ACTIONS,
  runPaletteRow,
  tabActionFor,
  type PaletteRunHandlers,
} from "./paletteRun";

function row(partial: Partial<PaletteRow>): PaletteRow {
  return {
    id: "Tab: New",
    label: "New tab",
    group: "Tab",
    keys: "",
    binding: "Tab: New",
    run: { kind: "tab", command: "new" },
    needs: "none",
    hint: null,
    blockedReason: null,
    ...partial,
  };
}

function named(): PaletteRunHandlers {
  return {
    tab: vi.fn(),
    app: vi.fn(),
    zoom: vi.fn(),
    editor: vi.fn(),
  };
}

describe("running a row through named handlers", () => {
  it("names every app action once", () => {
    expect(new Set(PALETTE_APP_ACTIONS).size).toBe(PALETTE_APP_ACTIONS.length);
  });

  it("names the tab command it runs, including the number key's last tab", () => {
    expect(tabActionFor("new")).toBe("new");
    expect(tabActionFor("toggle-terminal")).toBe("toggle-terminal");
    expect(tabActionFor({ activate: -1 })).toBe("activate-last");
    expect(tabActionFor({ focus: "left" })).toBe("focus-left");
  });

  it("hands the action's own name to each named handler", () => {
    const next = named();
    expect(runPaletteRow(row({}), next)).toBe(true);
    expect(next.tab).toHaveBeenCalledWith("new");

    expect(
      runPaletteRow(row({ run: { kind: "app", action: "changes" } }), next),
    ).toBe(true);
    expect(next.app).toHaveBeenCalledWith("changes");

    expect(
      runPaletteRow(row({ run: { kind: "zoom", action: "zoom-reset" } }), next),
    ).toBe(true);
    expect(next.zoom).toHaveBeenCalledWith("zoom-reset");

    expect(
      runPaletteRow(row({ run: { kind: "editor", action: "replace" } }), next),
    ).toBe(true);
    expect(next.editor).toHaveBeenCalledWith("replace");
  });

  it("runs nothing for a greyed row, an unknown name, or a handler that throws", () => {
    const next = named();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      runPaletteRow(row({ blockedReason: "Open a chat first" }), next),
    ).toBe(false);
    expect(
      runPaletteRow(
        row({ run: { kind: "app", action: "not-a-thing" as never } }),
        next,
      ),
    ).toBe(false);
    next.tab.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(runPaletteRow(row({}), next)).toBe(false);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(next.app).not.toHaveBeenCalled();
    expect(next.zoom).not.toHaveBeenCalled();
  });

  it("gives every palette row an action App can hand on", () => {
    for (const command of PALETTE_COMMANDS) {
      const entry = row({ ...command, hint: null, blockedReason: null });
      if (entry.run.kind === "tab") {
        expect(tabActionFor(entry.run.command)).not.toBeNull();
      }
      if (entry.run.kind === "app") {
        expect(PALETTE_APP_ACTIONS).toContain(entry.run.action);
      }
    }
    expect(new Set(PALETTE_TAB_ACTIONS).size).toBe(PALETTE_TAB_ACTIONS.length);
  });
});
