// r97 item 1 (Critiquito, c02 BLIND 242d): the sidebar's Working list showed "Searching for *select:…", the harness
// looking up its own tools, and "Running npm test" (item k). Its rows go through the same plain words as the chat: no tool lookups, no raw commands.
import { expect, it } from "vitest";
import { liveStep, plainToolStep } from "./liveActivity";
import type { Block } from "./session";

const lookup: Block = {
  id: "s",
  role: "tool",
  text: "Find select:mcp__monocode__delegate_task,mcp__memory__ash_remember",
  tool: { kind: "search", status: "in_progress", title: "Find select:mcp__monocode__delegate_task,mcp__memory__ash_remember", preview: { kind: "search", query: "select:mcp__monocode__delegate_task,mcp__memory__ash_remember" } },
} as Block;
const run = (command: string, status = "in_progress"): Block => ({ id: command, role: "tool", text: command, tool: { kind: "execute", status, command } }) as Block;

it("a tool lookup is never a sidebar step", () => {
  expect(plainToolStep(lookup)).toBe("Getting ready");
  expect(liveStep([lookup], undefined, "name").label).toBe("Thinking");
  expect(liveStep([run("npm test", "completed"), lookup], undefined, "name").lastStep).not.toMatch(/select:|mcp__/);
});

it("raw commands read in the chat's plain words", () => {
  expect(plainToolStep(run("npm test"))).toBe("Run the tests");
  expect(plainToolStep(run("git diff --stat && echo '---' && git diff -- packages/ui"))).toBe("Look at the changes");
  expect(plainToolStep(run("rg -n --heading 'BoardTally|title' packages/ui; npm test"))).toBe("Search the code, then run the tests");
  expect(plainToolStep(run("make deploy"))).toBe("Running make deploy");
});
