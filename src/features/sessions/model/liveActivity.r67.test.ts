import { expect, it } from "vitest";
import type { Block } from "./session";
import { activityLine, forgetActivity, STALL_MS, THINK_STALL_MS, trackActivity } from "./liveActivity";

// r67 (realconv S8 on 0.16.8): the Tally lead sat 81 s silent after a Read and the line went straight from "Thinking"
// to "No activity for 1 min"; in 12 minutes "Still working on ..." never showed, because a model that streams no
// thinking sends nothing between steps and the 60 s stall check ran before the 60 s still-working one.
const user: Block = { id: "u", role: "user", text: "go" };
const tool = (id: string, status: string, t: Partial<NonNullable<Block["tool"]>>): Block =>
  ({ id, role: "tool", text: "", tool: { ...t, status } }) as Block;
const read = { kind: "read", title: "Read", preview: { kind: "read", path: "/repo/src/stats.ts" } } as Partial<NonNullable<Block["tool"]>>;
const npm = { kind: "execute", title: "Bash", command: "npm test" } as Partial<NonNullable<Block["tool"]>>;

it("silent thinking after a tool reads 'Still working on <last step>' from 60 s, and stalled only after 5 min", () => {
  const t0 = 5_000_000;
  trackActivity("r67-a", [user, tool("r", "running", read)], t0, "/repo", undefined, undefined, { detail: "name" });
  // The Read ends; nothing else comes (no reasoning stream).
  const a = trackActivity("r67-a", [user, tool("r", "completed", read)], t0 + 2_000, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + 30_000).text).toBe("Thinking · 28s");
  expect(activityLine(a, t0 + 2_000 + 61_000)).toEqual({ text: "Still working on reading stats.ts · 1m 01s", stalled: false });
  expect(activityLine(a, t0 + 2_000 + 81_000).stalled).toBe(false);
  expect(activityLine(a, t0 + 2_000 + THINK_STALL_MS - 1).text).toMatch(/^Still working on reading stats\.ts · 4m 59s$/);
  expect(activityLine(a, t0 + 2_000 + THINK_STALL_MS)).toEqual({ text: "No activity for 5 min", stalled: true });
  forgetActivity("r67-a");
});

it("a running tool with nothing new still reads stalled after a minute", () => {
  const t0 = 6_000_000;
  const a = trackActivity("r67-b", [user, tool("c", "running", npm)], t0, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + STALL_MS - 1).text).toBe("Running npm test · 59s");
  expect(activityLine(a, t0 + STALL_MS)).toEqual({ text: "No activity for 1 min", stalled: true });
  forgetActivity("r67-b");
});
