import { expect, it } from "vitest";
import type { Block } from "./session";
import { activityLine, forgetActivity, trackActivity } from "./liveActivity";

// r66 (Alfred, 0.16.5): a Mono's 1:1 and a room turn read "Thinking" for 5+ minutes. Both name their steps the r65 way
// (detail "name"), and after a minute of thinking with no tool, while the stream still beats, the line says what it is
// still on.
const user: Block = { id: "u", role: "user", text: "go" };
const done = (id: string, t: NonNullable<Block["tool"]>): Block => ({ id, role: "tool", text: "", tool: { ...t, status: "completed" } });
const running = (id: string, t: NonNullable<Block["tool"]>): Block => ({ id, role: "tool", text: "", tool: { ...t, status: "running" } });
const think = (id: string, text: string): Block => ({ id, role: "reasoning", text }) as Block;

it("a 1:1 or room turn names its tool step, and after 60 s thinking with no tool says what it is still on", () => {
  const t0 = 1_000_000;
  const npm = { kind: "execute", title: "Bash", command: "npm test" } as NonNullable<Block["tool"]>;
  expect(activityLine(trackActivity("r66-a", [user, running("c", npm)], t0, "/repo", undefined, undefined, { detail: "name" }), t0).text).toBe("Running npm test · 0s");
  // The tool finished; it thinks. The stream keeps beating (new blocks or words), so it never reads stalled.
  let blocks: Block[] = [user, done("c", npm), think("k", "hm")];
  let a = trackActivity("r66-a", blocks, t0 + 1_000, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + 15_000).text).toBe("Thinking · 14s");
  blocks = [user, done("c", npm), think("k", "hm, the failing test is in the room")];
  a = trackActivity("r66-a", blocks, t0 + 50_000, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(a, t0 + 62_000)).toEqual({ text: "Still working on running npm test · 1m 01s", stalled: false });
  forgetActivity("r66-a");
});

it("with no tool yet it says just 'Still working'; a new tool step goes back to naming it", () => {
  const t0 = 2_000_000;
  const a = trackActivity("r66-b", [user, think("k", "x")], t0, "/repo", undefined, undefined, { detail: "name" });
  const b = trackActivity("r66-b", [user, think("k", "xy")], t0 + 55_000, "/repo", undefined, undefined, { detail: "name" });
  expect(a.lastStep).toBeUndefined();
  expect(activityLine(b, t0 + 61_000).text).toBe("Still working · 1m 01s");
  const read = { kind: "read", title: "Read", preview: { kind: "read", path: "/repo/src/app.tsx" } } as NonNullable<Block["tool"]>;
  const c = trackActivity("r66-b", [user, think("k", "xy"), running("r", read)], t0 + 62_000, "/repo", undefined, undefined, { detail: "name" });
  expect(activityLine(c, t0 + 63_000).text).toBe("Reading app.tsx · 1s");
  forgetActivity("r66-b");
});
