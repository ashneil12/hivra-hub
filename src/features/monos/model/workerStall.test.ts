// A worker can be stuck without asking or failing (Ash 20 Oct): quiet mid-turn, looping on one step, or idle without a
// report. Before this, the delegation rows only knew question, failed and cancelled, so such a worker read "working"
// for ever. The watcher judges each running row's chat and writes the stall on the row, once per change.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import { STALL_DEFAULTS, StallWatch, type Presence } from "./workerStall";
import type { Wake } from "../../firstmate/watcher/classifier";

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

describe("stallOptions", () => {
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
    const wakes: Wake[] = [];
    const stops: { id: string; error: string }[] = [];
    const watch = new StallWatch({
      tracker: () => tracker,
      session: (id) => sessions.get(id),
      openOwned: (chatId) => tracker.known().filter((r) => r.ownerSession === chatId && r.state !== "completed").length,
      now: () => now,
      wake: (wake) => wakes.push(wake),
      silent: (stopped, stop) => stops.push({ id: stopped.id, error: stop.error }),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { backend, tracker, sessions, row, watch, settle, wakes, stops, at: (ms: number) => (now = ms) };
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

  it("Hivra WP-11: tells the first mate once per silent stretch, and stops the worker once after twenty silent minutes", async () => {
    const t = await setup();
    t.sessions.set("w1", chat([asked(), said("Looking")]));
    for (const minute of [0, 6, 7, 8, 12, 19]) {
      t.at(minute * MIN);
      t.watch.tick();
      await t.settle();
    }
    expect(t.wakes.map((w) => w.kind)).toEqual(["stall"]);
    expect(t.stops).toEqual([]);
    t.at(20 * MIN);
    t.watch.tick();
    await t.settle();
    t.at(21 * MIN);
    t.watch.tick();
    expect(t.stops).toEqual([{ id: t.row.id, error: expect.stringContaining("Silent for 20 minutes") }]);
  });

  it("WP-102: a look that arrives after the computer slept stops nobody, and its clock moves forward by the gap", async () => {
    const t = await setup();
    t.sessions.set("w1", chat([asked(), said("Looking")]));
    for (const minute of [0, 6, 7]) {
      t.at(minute * MIN);
      t.watch.tick();
      await t.settle();
    }
    // It went quiet after re-arming at minute 6: one stall notice, as any quiet worker gets.
    expect(t.wakes.map((w) => w.key)).toEqual([`stall:${t.row.id}:1:${0}`]);
    const before = t.wakes.length;
    // The computer slept from minute 7 to minute 187. The look at 187 judges nothing, so no stop and no new notice.
    const woke = 187 * MIN;
    t.at(woke);
    t.watch.tick(180 * MIN);
    await t.settle();
    expect(t.stops).toEqual([]);
    expect(t.wakes).toHaveLength(before);
    // A worker that stays silent after the wake is still stopped 20 minutes of real silence later. Its clock now starts
    // at the wake (the gap was 180 minutes, and 180 was given up, so last activity reads as minute 7 + 180 = 187).
    t.at(woke + 6 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.stops).toEqual([]);
    t.at(woke + 20 * MIN);
    t.watch.tick(0);
    await t.settle();
    expect(t.stops).toEqual([{ id: t.row.id, error: expect.stringContaining("Silent for 20 minutes") }]);
  });

  it("WP-102: without a sleep the same silence still stops the worker at 20 minutes", async () => {
    const t = await setup();
    t.sessions.set("w1", chat([asked(), said("Looking")]));
    t.at(0);
    t.watch.tick();
    await t.settle();
    t.at(20 * MIN);
    t.watch.tick(0);
    await t.settle();
    expect(t.stops).toEqual([{ id: t.row.id, error: expect.stringContaining("Silent for 20 minutes") }]);
  });

  it("Hivra WP-11: a worker waiting on an approval is never silent, and activity re-arms the notice", async () => {
    const t = await setup();
    const approval = { ...tool("Bash", "pending", ""), approval: { decided: false } } as unknown as Block;
    t.sessions.set("w1", chat([asked(), approval]));
    for (const minute of [0, 10, 30, 90]) {
      t.at(minute * MIN);
      t.watch.tick();
      await t.settle();
    }
    expect(t.wakes).toEqual([]);
    expect(t.stops).toEqual([]);
    // Answered: it works, goes quiet again, and that is a new stretch with its own notice.
    t.sessions.set("w1", chat([asked(), said("Approved, carrying on")]));
    t.at(91 * MIN);
    t.watch.sync();
    t.watch.tick();
    t.at(98 * MIN);
    t.watch.tick();
    await t.settle();
    expect(t.wakes.map((w) => w.key)).toEqual([`stall:${t.row.id}:1:${91 * MIN}`]);
  });
});
