// r97 (Critiquito d, r95): the Lead's live line read "Still working on handing work to a worker · 20s". It reads
// "Handing out a job · 20s".
import { expect, it } from "vitest";
import { activityLine, liveStep, plainToolStep } from "./liveActivity";
import type { Block } from "./session";

const delegate = (status: string): Block =>
  ({ id: "d", role: "tool", text: "mcp__monocode__delegate_task", tool: { kind: "mcp__monocode__delegate_task", status, title: "mcp__monocode__delegate_task" } }) as Block;

it("the hand-off step says it plainly", () => {
  expect(plainToolStep(delegate("in_progress"))).toBe("Handing out a job");
  expect(liveStep([delegate("in_progress")]).label).toBe("Handing out a job");
});

it("thinking after a hand-off reads 'Handing out a job · 20s', never 'Still working on handing work…'", () => {
  const step = liveStep([delegate("completed"), { id: "r", role: "reasoning", text: "", streaming: true } as Block]);
  expect(step.lastStep).toBe("Handing out a job");
  const now = 100_000;
  const line = activityLine({ ...step, label: "Thinking", since: now - 20_000, stepSince: now - 20_000, lastEventAt: now }, now);
  expect(line.text).toBe("Handing out a job · 20s");
  expect(line.text).not.toMatch(/Still working|handing work to a worker/i);
});

it("other quiet steps keep 'Still working on …'", () => {
  const now = 100_000;
  expect(activityLine({ key: "k", label: "Thinking", lastStep: "Run the tests", since: now - 25_000, stepSince: now - 25_000, lastEventAt: now }, now).text).toBe("Still working on running the tests · 25s");
  expect(activityLine({ key: "k", label: "Thinking", lastStep: "Search the code, then run the tests", since: now - 25_000, stepSince: now - 25_000, lastEventAt: now }, now).text).toBe("Still working on searching the code, then running the tests · 25s");
});
