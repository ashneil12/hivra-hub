// r92 (s19 blind run d452): the harness looking up its own tools ("Find select:mcp__monocode__delegate_task,…") shows
// no row in the chat; a real search of the project keeps its row.
import { describe, expect, it } from "vitest";
import { isHiddenTool, isToolLookup } from "./transcriptActivity";
import type { Block } from "./session";

const search = (text: string, query: string, extra: Partial<NonNullable<Block["tool"]>> = {}): Block => ({
  id: text,
  role: "tool",
  text,
  tool: { kind: "search", status: "completed", preview: { kind: "search", query }, ...extra },
});

describe("tool lookups stay out of the chat", () => {
  it("hides the s19 row, as the app saved it", () => {
    const row = search(
      "Find select:mcp__monocode__delegate_task,mcp__ash-os__ash_recall",
      "select:mcp__monocode__delegate_task,mcp__ash-os__ash_recall",
      { detail: 'ToolSearch: {"query":"select:mcp__monocode__delegate_task"}' },
    );
    expect(isToolLookup(row)).toBe(true);
    expect(isHiddenTool(row)).toBe(true);
  });
  it("hides a keyword ToolSearch and a bare list of tool names", () => {
    expect(isHiddenTool(search("Find slack send", "slack send", { detail: 'ToolSearch: {"query":"slack send"}' }))).toBe(true);
    expect(isHiddenTool(search("Find mcp__monocode__delegate_task", "mcp__monocode__delegate_task"))).toBe(true);
  });
  it("keeps a real project search", () => {
    const row = search("Find monday|rollover|week", "monday|rollover|week", { detail: 'Grep: {"pattern":"monday"}' });
    expect(isToolLookup(row)).toBe(false);
    expect(isHiddenTool(row)).toBe(false);
  });
});
