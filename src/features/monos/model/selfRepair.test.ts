// Self-repair (board H3), with a fake clock and fake workers: a crashed or hung worker is retried with backoff, then
// handed to its Lead. Ported from the old workerProgress tests when the folder-reading hourly judge went (21 Oct).
import { beforeEach, describe, expect, it } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { StuckNotifier } from "../../notifications/model/stuckNotifications";
import type { Block, Session } from "../../sessions/model/session";
import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import { StallWatch } from "./workerStall";
import { failureLine, stuckWorkers } from "./workerStuck";
import { gaveUpReason, repairableFailure, SelfRepair } from "./selfRepair";

const MIN = 60_000;
const HOUR = 60 * MIN;
let seq = 0;
const asked = (): Block => ({ id: `b${++seq}`, role: "user", text: "Fix the save bug", startedAt: 0 });
const said = (text: string): Block => ({ id: `b${++seq}`, role: "assistant", text });
const edit = (file = "save.ts"): Block => ({ id: `b${++seq}`, role: "tool", text: `Edit ${file}`, tool: { kind: "edit", title: `Edit ${file}`, status: "completed", detail: "" } });

beforeEach(() => {
  resetCodingTeamChats();
  noteCodingTeamChat("lead", "vg-game");
});

type Chat = Pick<Session, "busy" | "blocks" | "cwd" | "pendingQuestion" | "usageLimit" | "queuedMessages" | "queueStatus">;

async function setup() {
  const backend = new MemoryDelegations();
  const tracker = new DelegationTracker(backend, {
    session: () => undefined,
    load: async () => null,
    openOwner: async () => null,
    isMono: () => true,
    queueReport: async () => undefined,
    quitting: () => false,
  });
  await tracker.boot(false);
  const launch = tracker.launch({ ownerSession: "lead", ownerMono: "vg-game-lead", requestId: "r1", childSession: "w1", title: "Fix the save bug", goal: "Saves survive a restart" });
  const row = (await launch.row) as Delegation;
  const chats = new Map<string, Chat>([["w1", { busy: true, blocks: [asked(), said("Reading the save code")], cwd: "/repo" }]]);
  let now = 0;
  const lead: string[] = [];
  const worker: string[] = [];
  const notifier = new StuckNotifier(0);
  const ash: string[] = [];
  const stopped: string[] = [];
  const dropped: string[] = [];
  const openOwned = (chat: string) => tracker.known().filter((r) => r.ownerSession === chat && r.state === "running").length;
  const repair = new SelfRepair({
    tracker: () => tracker,
    session: (id: string) => chats.get(id),
    tellLead: (_row: Delegation, text: string) => void lead.push(text),
    message: async (_row: Delegation, text: string) => (worker.push(text), true),
    stopTurn: async (r: Delegation) => (stopped.push(r.childSession), true),
    dropReport: (r: Delegation) => void dropped.push(r.id),
    now: () => now,
  });
  const watch = new StallWatch({ tracker: () => tracker, session: (id) => chats.get(id), openOwned, now: () => now, hourly: (r) => repair.stallFor(r) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fake = { quiet: false };
  const chat = () => chats.get("w1")!;
  const push = (...blocks: Block[]) => chats.set("w1", { ...chat(), blocks: [...chat().blocks, ...blocks] });
  let step = 0;
  /** One half-minute look, as useStallWatch runs it: self-repair first, then the stall watcher writes. */
  const look = async (at: number) => {
    now = at;
    if (!fake.quiet && chat().busy)
      push({ id: `b${++seq}`, role: "tool", text: "Read", tool: { kind: "read", title: `Read file ${++step}`, status: "completed", detail: `${step}` } });
    await repair.tick();
    watch.sync();
    watch.tick();
    await settle();
    for (const stuck of notifier.due(stuckWorkers(tracker.known(), now))) ash.push(stuck.line);
  };
  return {
    fake, backend, tracker, row, chats, chat, push, repair, look, lead, worker, ash, stopped, dropped,
    stored: () => backend.get(row.id),
    mutate: async (change: (row: Delegation) => void) => {
      change(backend.get(row.id));
      await tracker.refresh([row.id], "lead");
    },
  };
}

describe("self-repair (H3)", () => {
  const crash = async (t: Awaited<ReturnType<typeof setup>>, at: number, error = "Claude exited with code 1") => {
    await t.mutate((row) => {
      row.state = "failed";
      row.error = error;
      row.errorClass = undefined;
      row.retryable = undefined;
      row.settledAt = at;
      row.delivery = "pending"; // Its failure report is waiting for its Lead.
      row.log = [...row.log, { at, by: "app", event: "settled", state: "failed" }];
    });
    t.chats.set("w1", { ...t.chat(), busy: false });
  };
  const revive = async (t: Awaited<ReturnType<typeof setup>>) => {
    await t.mutate((row) => {
      row.state = "running";
      row.error = null;
      row.settledAt = null;
    });
    t.chats.set("w1", { ...t.chat(), busy: true });
  };

  it("which failures it retries: crashes and passing provider faults, never billing, sign-in, limits, Ash's stop or a report already read", () => {
    const failed = { state: "failed" as const, error: "", errorClass: undefined, retryable: undefined, delivery: undefined };
    expect(repairableFailure({ ...failed, error: "Claude exited with code 137" })).toBe(true);
    expect(repairableFailure({ ...failed, error: "socket hang up" })).toBe(true);
    expect(repairableFailure({ ...failed, errorClass: "overloaded" })).toBe(true);
    expect(repairableFailure({ ...failed, errorClass: "provider_error" })).toBe(true);
    expect(repairableFailure({ ...failed, errorClass: "billing" })).toBe(false);
    expect(repairableFailure({ ...failed, errorClass: "auth" })).toBe(false);
    expect(repairableFailure({ ...failed, errorClass: "usage_limit" })).toBe(false);
    expect(repairableFailure({ ...failed, error: "Claude exited", retryable: false })).toBe(false);
    expect(repairableFailure({ ...failed, error: "Claude exited", delivery: "delivered" })).toBe(false);
    expect(repairableFailure({ ...failed, error: "The model refused the brief" })).toBe(false);
    expect(repairableFailure({ ...failed, state: "cancelled" as never, error: "Stopped by Ash" })).toBe(false);
  });

  it("retries a crashed worker 1, 5 and 15 minutes on, dropping its failure report each time, then gives up and tells its Lead", async () => {
    const t = await setup();
    await t.look(0);
    await crash(t, 10 * MIN);
    await t.look(10 * MIN + 30_000);
    expect(t.worker).toEqual([]); // Not yet: one minute.
    await t.look(11 * MIN);
    expect(t.worker).toEqual([CONTINUE_PROMPT]);
    expect(t.dropped).toEqual([t.row.id]);
    // It runs, crashes again straight away: five minutes this time.
    await revive(t);
    await t.look(12 * MIN);
    await crash(t, 12 * MIN);
    await t.look(15 * MIN);
    expect(t.worker).toHaveLength(1);
    await t.look(16 * MIN);
    expect(t.worker).toHaveLength(2);
    await revive(t);
    await t.look(17 * MIN);
    await crash(t, 17 * MIN);
    await t.look(30 * MIN);
    expect(t.worker).toHaveLength(2);
    await t.look(31 * MIN);
    expect(t.worker).toHaveLength(3);
    // A fourth crash: no fourth try.
    await revive(t);
    await t.look(32 * MIN);
    await crash(t, 33 * MIN);
    await t.look(3 * HOUR);
    expect(t.worker).toHaveLength(3);
    expect(t.lead).toEqual([
      '"Fix the save bug": crashed 4 times, retries gave up: Claude exited with code 1. Handle it yourself, without asking Ash: retry it differently or split it (delegate_task with redoes "t-1"), or stop it (task_cancel t-1), then say in one line here what you did. Only if the fix needs something only Ash can give (a key or sign-in, a delete, or a money decision), tell him in one plain line here the one thing you need.',
    ]);
    expect(t.dropped).toHaveLength(3); // The last failure reaches its Lead.
    // Its red card says what happened; no banner pushed while it's its Lead's.
    expect(stuckWorkers(t.tracker.known(), 3 * HOUR)[0]).toMatchObject({ kind: "failed", line: "Crashed 4 times, retries gave up: Claude exited with code 1" });
    expect(t.ash).toEqual([]);
  });

  it("says in plain words what it saw before it gave up", () => {
    expect(gaveUpReason({ state: "running", stallKind: "quiet", errorClass: null, error: null }, 4)).toBe("Went quiet 4 times, retries gave up");
    expect(gaveUpReason({ state: "running", stallKind: "idle", errorClass: null, error: null }, 4)).toBe(
      "Stopped without reporting back 4 times, retries gave up",
    );
    expect(gaveUpReason({ state: "failed", stallKind: null, errorClass: "overloaded", error: "529" }, 4)).toBe("Provider overloaded 4 times, retries gave up");
    const failures = (n: number) => Array.from({ length: n }, () => ({ at: 0, by: "app", event: "settled", state: "failed" }));
    const row = { state: "failed" as const, errorClass: null, error: "Claude exited with code 1.", resetsAt: null };
    expect(failureLine({ ...row, log: failures(1) })).toBe("Failed: claude exited with code 1");
    expect(failureLine({ ...row, log: failures(2) })).toBe("Crashed 2 times: Claude exited with code 1");
    expect(failureLine({ ...row, log: failures(4) })).toBe("Crashed 4 times, retries gave up: Claude exited with code 1");
    // A refusal only Ash can fix is never a crash, however often it came back.
    expect(failureLine({ ...row, errorClass: "billing", log: failures(4) })).toMatch(/^Failed: /);
  });

  it("never retries a billing failure or one its Lead already read; a billing refusal is still Ash's banner", async () => {
    const t = await setup();
    await t.look(0);
    await crash(t, MIN, "Credit balance is too low");
    await t.mutate((row) => void (row.errorClass = "billing"));
    await t.look(30 * MIN);
    const other = await setup();
    await other.look(0);
    await crash(other, MIN);
    await other.mutate((row) => void (row.delivery = "delivered"));
    await other.look(30 * MIN);
    expect([...t.worker, ...other.worker]).toEqual([]);
    expect(t.ash).toEqual(["Failed: billing refused"]);
  });

  it("a hung busy worker is nudged first, then its turn is stopped and continued once the stop lands", async () => {
    const t = await setup();
    t.fake.quiet = true;
    await t.look(0);
    // Six quiet minutes: the stall watcher marks it quiet.
    await t.look(6 * MIN);
    await t.look(6.5 * MIN);
    expect(t.stored().stallKind).toBe("quiet");
    // It went quiet at 0 (its last output): the first try was due a minute after that, so the look that saw the
    // stall (6.5 min) nudged it.
    expect(t.worker).toHaveLength(1);
    expect(t.worker[0]).toMatch(/^Check-in from the app: there's been no output/);
    expect(t.stopped).toEqual([]);
    // Still quiet five minutes on: its turn is stopped, and not continued while the stop is landing.
    await t.look(11 * MIN);
    expect(t.stopped).toEqual([]);
    await t.look(11.5 * MIN);
    expect(t.stopped).toEqual(["w1"]);
    expect(t.worker).toHaveLength(1);
    await t.look(12 * MIN);
    expect(t.worker).toHaveLength(1);
    // The stop lands: its row reads cancelled, its chat idle. The next look continues it.
    await t.mutate((row) => void (row.state = "cancelled"));
    t.chats.set("w1", { ...t.chat(), busy: false });
    await t.look(12.5 * MIN);
    expect(t.worker[1]).toBe(CONTINUE_PROMPT);
    expect(t.dropped).toEqual([t.row.id]); // The stop's report isn't needed by its Lead.
  });

  it("a worker idle without reporting is continued (no nudge)", async () => {
    const t = await setup();
    t.chats.set("w1", { ...t.chat(), busy: false, blocks: [asked(), said("Done, I think")] });
    await t.look(0);
    await t.look(6 * MIN);
    await t.look(6.5 * MIN);
    expect(t.stored().stallKind).toBe("idle");
    await t.look(7.5 * MIN);
    expect(t.worker).toEqual([CONTINUE_PROMPT]);
    expect(t.stopped).toEqual([]);
  });

  it("a crash loop keeps counting its tries; half an hour of clean running starts them over", async () => {
    const t = await setup();
    await t.look(0);
    await crash(t, MIN);
    await t.look(2 * MIN);
    expect(t.repair.state(t.row.id)?.tries).toBe(1);
    await revive(t);
    t.push(edit());
    await t.look(3 * MIN);
    await t.look(20 * MIN);
    expect(t.repair.state(t.row.id)?.tries).toBe(1); // Still counting.
    await t.look(33 * MIN);
    expect(t.repair.state(t.row.id)).toBeUndefined();
  });
});
