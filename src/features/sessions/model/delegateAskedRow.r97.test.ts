// r97 item 3: a delegate row says what the Lead asked for, as a goal ("Asked a worker to: <job>"), from the job name the
// app passes back. It is never a result: the r96 guard (c02 6968, "Done when: … npm test passed") still holds.
import { expect, it } from "vitest";
import { delegateJobName } from "./monocodeToolCall";
import type { Block } from "./session";
import { toolCallLabel } from "./transcriptActivity";

const NAME = "mcp__monocode__delegate_task";
const call = (out: Record<string, unknown>, status = "completed"): Block =>
  ({ id: "d", role: "tool", text: NAME, tool: { kind: NAME, title: NAME, status, detail: JSON.stringify({ taskId: "t-1", childSessionId: "c", status: "running", ...out }) } }) as Block;

it("reads 242d's handoff as a goal", () => {
  expect(toolCallLabel(call({ title: "API health and negative bump" }))).toBe("Asked a worker to: API health and negative bump");
});

it("keeps it short", () => {
  const label = toolCallLabel(call({ title: "Show last week's total next to this week on the board and sort the rows by this week's total" }));
  expect(label.length).toBeLessThanOrEqual("Asked a worker to: ".length + 60);
  expect(label.endsWith("…")).toBe(true);
});

it("never shows a done claim", () => {
  expect(toolCallLabel(call({ title: "API health. Done when: GET /health says alive and npm test passed" }))).toBe("Asked a worker to: API health");
  expect(delegateJobName(call({ title: "Make npm test passed" }))).toBeUndefined();
  expect(toolCallLabel(call({ title: "Make npm test passed" }))).toBe("Delegated a task");
  expect(toolCallLabel(call({}))).toBe("Delegated a task");
  for (const title of ["API health and negative bump", "x. Done when: tests passed"])
    expect(toolCallLabel(call({ title }))).not.toMatch(/passed|done when/i);
});
