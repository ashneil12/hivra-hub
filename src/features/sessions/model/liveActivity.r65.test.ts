import { expect, it } from "vitest";
import type { Block } from "./session";
import { liveStep, toolName } from "./liveActivity";

// r65 (PM's r63 run): the live line said "Thinking" / "Using a tool"; it names the real tool and its target.
const user: Block = { id: "u", role: "user", text: "go" };
const tool = (id: string, t: NonNullable<Block["tool"]>, text = ""): Block => ({ id, role: "tool", text, tool: { status: "running", ...t } });

it("names the file, the command, the web search and any other tool", () => {
  expect(liveStep([user, tool("r", { kind: "read", title: "Read", preview: { kind: "read", path: "/repo/src/app.tsx" } })], "/repo", "name").label).toBe("Reading app.tsx");
  expect(liveStep([user, tool("c", { kind: "execute", title: "Bash", command: "npm test -- --run src/a.test.ts" })], "/repo", "name").label).toBe("Running npm test");
  expect(liveStep([user, tool("c2", { kind: "execute", title: "Bash", command: "npm test" })], "/repo", "full").label).toBe("Running npm test");
  expect(liveStep([user, tool("w", { kind: "search", title: "WebSearch", preview: { kind: "search", query: "tauri window state" } })], "/repo", "name").label).toBe("Searching the web");
  expect(liveStep([user, tool("g", { kind: "search", title: "Grep", preview: { kind: "search", query: "isCliNotice" } })], "/repo", "name").label).toBe("Searching for “isCliNotice”");
  expect(liveStep([user, tool("m", { kind: "other", title: "mcp__linear__list_issues" })], "/repo", "name").label).toBe("Using Linear: list issues");
});

it("tool names read plainly and never carry a path", () => {
  expect(toolName("TodoWrite")).toBe("todo write");
  expect(toolName("/Users/ash/bin/x")).toBeUndefined();
  expect(toolName("")).toBeUndefined();
});
