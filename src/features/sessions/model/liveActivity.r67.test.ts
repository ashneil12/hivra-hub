import { expect, it } from "vitest";
import type { Block } from "./session";
import { activityLine, forgetActivity, searchStep, STALL_MS, STILL_MS, THINK_STALL_MS, trackActivity } from "./liveActivity";

// r67 (realconv S8 on 0.16.8): the Tally lead sat 81 s silent after a Read and the line went straight from "Thinking"
// to "No activity for 1 min"; in 12 minutes "Still working on ..." never showed, because a model that streams no
// thinking sends nothing between steps and the 60 s stall check ran before the 60 s still-working one.
const user: Block = { id: "u", role: "user", text: "go" };
const tool = (id: string, status: string, t: Partial<NonNullable<Block["tool"]>>): Block =>
  ({ id, role: "tool", text: "", tool: { ...t, status } }) as Block;
const read = { kind: "read", title: "Read", preview: { kind: "read", path: "/repo/src/stats.ts" } } as Partial<NonNullable<Block["tool"]>>;
const npm = { kind: "execute", title: "Bash", command: "npm test" } as Partial<NonNullable<Block["tool"]>>;

it("silent thinking after a tool reads 'Still working on <last step>' from 20 s, and stalled only after 5 min", () => {
  const t0 = 5_000_000;
  trackActivity("r67-a", [user, tool("r", "running", read)], t0, "/repo", undefined, undefined, { detail: "name" });
  // The Read ends; nothing else comes (no reasoning stream).
  const a = trackActivity("r67-a", [user, tool("r", "completed", read)], t0 + 2_000, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + 2_000 + STILL_MS - 1).text).toBe("Thinking · 19s");
  // r67 (Alfred): from 20 s, not 60 s.
  expect(activityLine(a, t0 + 2_000 + STILL_MS)).toEqual({ text: "Still working on reading stats.ts · 20s", stalled: false });
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

it("a search for app ids reads in words, not the raw ids (Alfred: 'Searching for “d_1014e3d62a|d_1014d69d70|d_101…”')", () => {
  expect(searchStep("d_1014e3d62a|d_1014d69d70|d_1014f00a11")).toBe("Searching for 3 ids");
  expect(searchStep("a_10292eae8d")).toBe("Searching for an id");
  expect(searchStep("3f2b9c1e-8d4a-4b7e-9c2d-1a2b3c4d5e6f")).toBe("Searching for an id");
  expect(searchStep("model")).toBe("Searching for “model”");
  expect(searchStep("DeepSeek|deepseek on high|d_1014e3d62a")).toBe("Searching for “DeepSeek” and 2 more");
  expect(searchStep("\\bmedian\\(")).toBe("Searching for “median”");
  expect(searchStep("decade")).toBe("Searching for “decade”");
  expect(searchStep("2026-10-14")).toBe("Searching for “2026-10-14”");
});

it("the live line uses the worded search", () => {
  const t0 = 7_000_000;
  const grep = { kind: "search", title: "Grep", preview: { kind: "search", query: "d_1014e3d62a|d_1014d69d70" } } as Partial<NonNullable<Block["tool"]>>;
  const a = trackActivity("r67-c", [user, tool("g", "running", grep)], t0, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + 1_000).text).toBe("Searching for 2 ids · 1s");
  forgetActivity("r67-c");
});
