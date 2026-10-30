// r92 (Critiquito a, c; s19 blind run d452): shell search rows read in plain words in "Exploring the project".
import { describe, expect, it } from "vitest";
import { toolCallLabel, toolCategory } from "./transcriptActivity";
import type { Block } from "./session";

const shell = (text: string, command: string): Block => ({
  id: text,
  role: "tool",
  text,
  tool: { kind: "execute", status: "completed", command },
});

describe("plain search rows from shell commands", () => {
  it("(a) shows a raw rg pattern as 'Searched for …'", () => {
    const row = shell("Find monday|rollover|week", 'rg -n -i "monday|rollover|week" | head -200');
    expect(toolCallLabel(row, "/repo")).toBe("Searched for monday, rollover, week");
    expect(toolCategory(row)).toBe("research");
  });
  it("(c) shows rg --files as 'Search the project's files'", () => {
    const row = shell("Find files", "rg --files --hidden --iglob '**/*.{ts,tsx,md,json}'");
    expect(toolCallLabel(row, "/repo")).toBe("Search the project's files");
    expect(toolCategory(row)).toBe("research");
  });
  it("keeps a plain one-word find as it was", () => {
    expect(toolCallLabel(shell("Find median", 'rg -n "median"'), "/repo")).toBe("Find median");
  });
});
