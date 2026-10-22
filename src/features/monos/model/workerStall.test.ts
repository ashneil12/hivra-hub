// A worker can be stuck without asking or failing (Ash 20 Oct): quiet mid-turn, looping on one step, or idle without a
// report. Before this, the delegation rows only knew question, failed and cancelled, so such a worker read "working"
// for ever. The watcher judges each running row's chat and writes the stall on the row, once per change.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import { judgeStall, lookAt, STALL_DEFAULTS, StallWatch, type Presence } from "./workerStall";

const MIN = 60_000;
let seq = 0;
const tool = (title: string, status = "completed", detail = "ok"): Block => ({
  id: `b${++seq}`,
  role: "tool",
  text: title,
  tool: { kind: "execute", title, status, detail },
});
const said = (text: string): Block => ({ id: `b${++seq}`, role: "assistant", text });
const asked = (): Block => ({ id: `b${++seq}`, role: "user", text: "Fix the save bug", startedAt: 0 });

type Chat = Pick<Session, "busy" | "blocks" | "pendingQuestion" | "queuedMessages" | "queueStatus" | "usageLimit" | "cwd">;
const chat = (blocks: Block[], extra: Partial<Chat> = {}): Chat => ({ busy: true, blocks, cwd: "/repo", ...extra });
const seen = (over: Partial<Presence> = {}): Presence => ({ watchedSince: 0, lastProgressAt: 0, steps: 0, ...over });

describe("judgeStall", () => {
  it("a busy worker that keeps talking is fine; six quiet minutes make it stuck since its last change", () => {
    const look = lookAt(chat([asked(), said("Reading the save code")]));
    expect(judgeStall(look, seen({ lastChangeAt: 10 * MIN, lastProgressAt: 10 * MIN }), 15 * MIN)).toBeNull();
    expect(judgeStall(look, seen({ lastChangeAt: 10 * MIN, lastProgressAt: 10 * MIN }), 16 * MIN)).toEqual({
      kind: "quiet",
      reason: "",
      since: 10 * MIN,
    });
  });

  it("gives a step that is still running longer (20 min), and says which", () => {
    const look = lookAt(chat([asked(), tool("npm test", "in_progress", "")]));
    expect(look.runningTool).toBeTruthy();
    const presence = seen({ lastChangeAt: 0 });
    expect(judgeStall(look, presence, 12 * MIN)).toBeNull();
    const stall = judgeStall(look, presence, 20 * MIN);
    expect(stall?.kind).toBe("quiet");
    expect(stall?.reason).toMatch(/^Still running .*npm test/);
  });

  it("the same finished step with the same output six times in a row is a loop; a different output breaks it", () => {
    const five = [asked(), ...Array.from({ length: 5 }, () => tool("gh pr checks", "completed", "pending"))];
    expect(lookAt(chat(five)).repeat?.count).toBe(5);
    expect(judgeStall(lookAt(chat(five)), seen({ lastChangeAt: 100 }), 200)).toBeNull();
    const six = [...five, tool("gh pr checks", "completed", "pending")];
    const stall = judgeStall(lookAt(chat(six)), seen({ lastChangeAt: 100, repeatSince: 150 }), 200);
    expect(stall).toMatchObject({ kind: "loop", since: 150 });
    expect(stall?.reason).toMatch(/^Repeating the same step: .*gh pr checks.* \(6 times\)$/);
    const varied = [...five, tool("gh pr checks", "completed", "1 failing")];
    expect(lookAt(chat(varied)).repeat).toBeUndefined();
  });

  it("an hour without a new step is left to the hourly progress check (workerProgress.ts), which reads real progress", () => {
    const look = lookAt(chat([asked(), tool("npm test")]));
    const presence = seen({ lastChangeAt: 59 * MIN, lastProgressAt: 0 });
    expect(judgeStall(look, presence, 60 * MIN)).toBeNull();
  });

  it("idle with its row still running means it stopped without reporting; a question, a queued message or a limit holds it", () => {
    const idle = chat([asked(), said("Done, I think")], { busy: false });
    expect(judgeStall(lookAt(idle), seen({ lastChangeAt: 0 }), 5 * MIN)).toBeNull();
    expect(judgeStall(lookAt(idle), seen({ lastChangeAt: 0 }), 6 * MIN)).toEqual({
      kind: "idle",
      reason: "Stopped without reporting back",
      since: 0,
    });
    const queued = { ...idle, queuedMessages: [{ id: "m", text: "go on", attachments: [] }] } as Chat;
    expect(judgeStall(lookAt(queued), seen(), 60 * MIN)).toBeNull();
    expect(judgeStall(lookAt({ ...queued, queueStatus: "paused" }), seen(), 60 * MIN)?.kind).toBe("idle");
    const resumeStopped = chat([asked(), { id: "n", role: "system", text: "Stopped resuming", notice: "resume-stopped" } as Block], {
      busy: false,
    });
    expect(judgeStall(lookAt(resumeStopped), seen(), 6 * MIN)?.reason).toBe("Stopped resuming itself after restarts");
  });

  it("unknown is never stuck: the clock starts when this window first sees the worker", () => {
    const look = lookAt(chat([asked()]));
    expect(judgeStall(look, seen({ watchedSince: 100 * MIN, lastProgressAt: 100 * MIN }), 105 * MIN)).toBeNull();
    expect(judgeStall(look, seen({ watchedSince: 100 * MIN, lastProgressAt: 100 * MIN }), 106 * MIN)?.since).toBe(100 * MIN);
  });

  it("reads the stall minutes from settings, keeping the long-step wait at least three times it", async () => {
    const { stallOptions } = await import("./workerStall");
    const stored = new Map<string, string>([["monocode:stall-minutes", "10"]]);
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => stored.get(k) ?? null }, configurable: true });
    try {
      expect(stallOptions()).toMatchObject({ quietMs: 10 * MIN, idleMs: 10 * MIN, longToolMs: 30 * MIN });
      stored.set("monocode:stall-minutes", "nonsense");
      expect(stallOptions()).toEqual(STALL_DEFAULTS);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  });
});

describe("StallWatch", () => {
  async function setup() {
    const backend = new MemoryDelegations();
    const sessions = new Map<string, Chat>();
    const tracker = new DelegationTracker(backend, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => true,
      queueReport: async () => undefined,
      quitting: () => false,
    });
    await tracker.boot(false);
    const launch = tracker.launch({ ownerSession: "lead", ownerMono: "vg-game-lead", requestId: "r1", childSession: "w1", title: "Fix the save bug" });
    const row = (await launch.row) as Delegation;
    let now = 0;
    const watch = new StallWatch({
      tracker: () => tracker,
      session: (id) => sessions.get(id),
      openOwned: (chatId) => tracker.known().filter((r) => r.ownerSession === chatId && r.state !== "completed").length,
      now: () => now,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { backend, tracker, sessions, row, watch, settle, at: (ms: number) => (now = ms) };
  }

  it("raises a quiet worker's stall on the row once, and clears it the moment the worker talks again", async () => {
    const t = await setup();
    t.sessions.set("w1", chat([asked(), said("Looking")]));
    t.at(0);
    t.watch.tick();
    t.at(5 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.backend.get(t.row.id).stallKind ?? null).toBeNull();
    t.at(6 * MIN);
    t.watch.tick();
    await t.settle();
    t.at(6.5 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.backend.get(t.row.id)).toMatchObject({ state: "running", stallKind: "quiet", stalledAt: 0 });
    expect(t.backend.calls.filter((c) => c.startsWith("stall:"))).toEqual([`stall:${t.row.id}:quiet`]);
    // It talks again: one sync clears it.
    t.sessions.set("w1", chat([asked(), said("Looking"), said("Found it")]));
    t.at(7 * MIN);
    t.watch.sync();
    await t.settle();
    expect(t.backend.get(t.row.id).stallKind).toBeNull();
    expect(t.tracker.row(t.row.id)?.stallKind).toBeNull();
  });

  it("never judges a worker this window doesn't run, and keeps a stall from before a restart until it moves", async () => {
    const t = await setup();
    t.at(60 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.backend.calls.filter((c) => c.startsWith("stall:"))).toEqual([]);
    // A stall stored before a restart: a fresh watcher sees the chat for the first time and leaves it.
    await t.tracker.setStall(t.row, { kind: "idle", reason: "Stopped without reporting back", since: 1 });
    t.sessions.set("w1", chat([asked()], { busy: false }));
    t.watch.sync();
    t.watch.tick();
    await t.settle();
    expect(t.backend.get(t.row.id).stallKind).toBe("idle");
  });

  it("never overwrites or clears a block the agent declared (task_cannot): it is the agent's word until the row moves", async () => {
    const t = await setup();
    await t.tracker.setStall(t.row, { kind: "blocked", reason: "The staging deploy key is not on this machine", since: 0 }, "self:w1");
    expect(t.backend.get(t.row.id)).toMatchObject({ stallKind: "blocked" });
    // Then the chat goes quiet, and later idle: the watcher would judge either, but a block is not a judgment.
    t.sessions.set("w1", chat([asked(), said("Blocked on the key")]));
    t.at(0);
    t.watch.tick();
    t.at(90 * MIN);
    t.watch.tick();
    t.watch.sync();
    t.sessions.set("w1", chat([asked(), said("Blocked on the key")], { busy: false }));
    t.at(180 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.backend.get(t.row.id)).toMatchObject({
      stallKind: "blocked",
      stallReason: "The staging deploy key is not on this machine",
    });
    expect(t.backend.calls.filter((c) => c.startsWith("stall:"))).toEqual([`stall:${t.row.id}:blocked`]);
  });

  it("leaves a chat that waits on its own workers alone", async () => {
    const t = await setup();
    t.sessions.set("w1", chat([asked(), tool("task_wait", "in_progress", "")]));
    t.tracker.launch({ ownerSession: "w1", requestId: "r2", childSession: "w2" });
    await t.settle();
    t.at(0);
    t.watch.tick();
    t.at(90 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.backend.get(t.row.id).stallKind ?? null).toBeNull();
  });
});
