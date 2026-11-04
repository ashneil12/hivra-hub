// r62: the backend events behind PM's live step line, and Critiquito's file-name rule. Every time and step here comes
// from the blocks a stream would write; nothing is invented.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "./session";
import { newSession } from "./session";
import { activityLine, forgetActivity, liveStep, noteWorkerProgress, trackActivity, workerProgress } from "./liveActivity";
import { publishWorkerProgress } from "../../monos/model/workerActivity";
import type { Delegation } from "../../monos/model/delegations";

const user: Block = { id: "u", role: "user", text: "Example: build it" };
const tool = (id: string, over: Partial<NonNullable<Block["tool"]>> = {}): Block => ({
  id,
  role: "tool",
  text: over.title ?? "Read",
  tool: { kind: "read", status: "in_progress", preview: { kind: "read", path: "/repo/src/app.tsx" }, ...over },
});

describe("tool times on the block (event 1)", () => {
  it("the step's timer starts when the tool started, and survives a reload", () => {
    forgetActivity("t");
    const blocks = [user, tool("r", { startedAt: 1_000, updatedAt: 5_000 })];
    // First seen 40s after the tool began (a reload): the timer reads from the tool's own start.
    const a = trackActivity("t", blocks, 41_000, "/repo");
    expect(a.since).toBe(1_000);
    expect(activityLine(a, 41_000).text).toBe("Reading src/app.tsx · 40s");
    // Its last event is the tool's last update, not the moment of the reload: 70s of nothing reads as a stall.
    expect(a.lastEventAt).toBe(5_000);
    expect(activityLine(a, 75_000)).toEqual({ text: "No activity for 1 min", stalled: true });
    forgetActivity("t");
  });
});

describe("heartbeat while a tool runs (event 2)", () => {
  it("a newer updatedAt on a quiet build is activity; without it the line stalls", () => {
    forgetActivity("h");
    const build = (updatedAt: number) => [user, tool("b", { kind: "execute", title: "npm run build", command: "npm run build", startedAt: 0, updatedAt, preview: undefined })];
    trackActivity("h", build(0), 1_000);
    const beat = trackActivity("h", build(80_000), 80_000);
    expect(beat.lastEventAt).toBe(80_000);
    expect(activityLine(beat, 100_000).stalled).toBe(false);
    // No heartbeat after that: a minute later it says so.
    expect(activityLine(trackActivity("h", build(80_000), 141_000), 141_000).stalled).toBe(true);
    forgetActivity("h");
  });
});

describe("the tool-started command or path (event 4) and file names in rooms and 1:1s", () => {
  it("coding chats name the path and the command; rooms and Mono 1:1s just the file", () => {
    expect(liveStep([user, tool("r")], "/repo", "full").label).toBe("Reading src/app.tsx");
    expect(liveStep([user, tool("r")], "/repo", "name").label).toBe("Reading app.tsx");
    const run = tool("c", { kind: "execute", title: "npm run build", command: "npm run build", preview: undefined });
    expect(liveStep([user, run], "/repo", "full").label).toBe("Running npm run build");
    // r65: a room or 1:1 names the command too, its first words only (PM: "Running npm test").
    expect(liveStep([user, run], "/repo", "name").label).toBe("Running npm run build");
  });
});

describe("worker progress to the parent turn (event 5)", () => {
  const waiting: Block = { id: "w", role: "tool", text: "Task", tool: { kind: "agent", title: "Task", status: "in_progress", startedAt: 1, updatedAt: 1 } };
  it("waiting on a worker says what the worker does, and the worker's activity keeps the parent from stalling", () => {
    forgetActivity("p");
    const a = trackActivity("p", [user, waiting], 90_000, undefined, undefined, undefined, { worker: { label: "Running a check", lastEventAt: 85_000 } });
    expect(a.label).toBe("Worker: running a check");
    expect(a.lastEventAt).toBe(85_000);
    expect(activityLine(a, 90_000).stalled).toBe(false);
    // Without the worker the same parent has had nothing for 90s.
    forgetActivity("p");
    expect(activityLine(trackActivity("p", [user, waiting], 90_000), 90_000).stalled).toBe(true);
    forgetActivity("p");
  });
  it("the delegation watch publishes each busy worker's step for its owner, and clears it when the worker stops", () => {
    const row = { id: "d1", ownerSession: "lead", childSession: "kid", state: "running" } as unknown as Delegation;
    const kid: Session = { ...newSession("claude", "/repo"), id: "kid", busy: true, blocks: [user, tool("k", { kind: "execute", title: "npm test", preview: undefined })] };
    publishWorkerProgress([row], [kid], 10_000);
    expect(workerProgress("lead")?.label).toBe("Running a check");
    publishWorkerProgress([row], [{ ...kid, busy: false }], 20_000);
    expect(workerProgress("lead")).toBeUndefined();
    noteWorkerProgress("lead", undefined);
  });
});

describe("the verify bench's record of the live line", () => {
  const store = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage;
  };
  it("is written only on the bench, once per line and text", async () => {
    const { noteLiveLine, VERIFY_LIVE_LINES_KEY } = await import("./verifyLiveLines");
    const seen = { key: "a", text: "ed · Thinking · 1s", runner: true, runnerAfterText: true, stalled: false };
    const off = store();
    noteLiveLine(seen, off, false);
    expect(off.getItem(VERIFY_LIVE_LINES_KEY)).toBeNull();
    const on = store();
    noteLiveLine(seen, on, true);
    noteLiveLine(seen, on, true);
    noteLiveLine({ ...seen, text: "ed · Thinking · 2s" }, on, true);
    expect(JSON.parse(on.getItem(VERIFY_LIVE_LINES_KEY)!).map((l: { text: string }) => l.text)).toEqual(["ed · Thinking · 1s", "ed · Thinking · 2s"]);
  });
});
