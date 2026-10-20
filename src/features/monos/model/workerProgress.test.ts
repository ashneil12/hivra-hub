// The hourly progress check and self-repair (board H2), with a fake clock and fake workers: each worker is a chat the
// test writes blocks into and a folder whose commits and diff the test sets. The app's hands (tell the Lead, message
// the worker, stop its turn, banner Ash) are recorded, and the stuck line is read the way the rail reads it.
import { beforeEach, describe, expect, it } from "vitest";
import { noteCodingTeamChat, resetCodingTeamChats } from "../../hub/model/codingTeam";
import { StuckNotifier } from "../../notifications/model/stuckNotifications";
import type { Block, Session } from "../../sessions/model/session";
import { CONTINUE_PROMPT } from "../../sessions/model/inFlight";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import { StallWatch } from "./workerStall";
import { countWork, delegationLine, failureLine, shortSplit, stuckWorkers } from "./workerStuck";
import {
  failingTestName,
  gaveUpReason,
  judgeProgress,
  progressNoteMessage,
  progressSignals,
  ProgressCheck,
  repairableFailure,
  tallyTranscript,
  type FolderLook,
} from "./workerProgress";

const MIN = 60_000;
const HOUR = 60 * MIN;
let seq = 0;
const asked = (): Block => ({ id: `b${++seq}`, role: "user", text: "Fix the save bug", startedAt: 0 });
const said = (text: string): Block => ({ id: `b${++seq}`, role: "assistant", text });
const edit = (file = "save.ts"): Block => ({ id: `b${++seq}`, role: "tool", text: `Edit ${file}`, tool: { kind: "edit", title: `Edit ${file}`, status: "completed", detail: "" } });
const test = (detail: string, status = "completed"): Block => ({ id: `b${++seq}`, role: "tool", text: "npm test", tool: { kind: "execute", title: "npm test", status, detail } });
const failing = (detail: string): Block => ({ id: `b${++seq}`, role: "tool", text: "npm run build", tool: { kind: "execute", title: "npm run build", status: "failed", detail } });
const turn = (tokens: number): Block => ({ id: `b${++seq}`, role: "user", text: "go on", turnMetrics: { inputTokens: tokens } });

// The Lead is a coding-team chat (an orchestrator), as a Mono's Lead would be: its workers are its to handle.
beforeEach(() => {
  resetCodingTeamChats();
  noteCodingTeamChat("lead", "vg-game");
});

type Chat = Pick<Session, "busy" | "blocks" | "cwd" | "pendingQuestion" | "usageLimit" | "queuedMessages" | "queueStatus">;

async function setup(options: { folder?: boolean } = {}) {
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
  const folder: FolderLook = { commits: 0, diff: { files: 0, additions: 0, deletions: 0 } };
  const commitTimes: number[] = [];
  let now = 0;
  const lead: string[] = [];
  const worker: string[] = [];
  // Ash's banners: what the stuck notifier would push, looked at the way useStuckNotifications does.
  const notifier = new StuckNotifier(0);
  const ash: string[] = [];
  const stopped: string[] = [];
  const dropped: string[] = [];
  const hands = {
    tracker: () => tracker,
    session: (id: string) => chats.get(id),
    openOwned: (chat: string) => tracker.known().filter((r) => r.ownerSession === chat && r.state === "running").length,
    folder: async (_cwd: string, since: number) =>
      options.folder === false ? null : { ...folder, commits: commitTimes.filter((at) => at >= since).length },
    tellLead: (_row: Delegation, text: string) => void lead.push(text),
    message: async (_row: Delegation, text: string) => (worker.push(text), true),
    stopTurn: async (r: Delegation) => (stopped.push(r.childSession), true),
    dropReport: (r: Delegation) => void dropped.push(r.id),
    now: () => now,
  };
  const check = new ProgressCheck(hands);
  const watch = new StallWatch({
    tracker: () => tracker,
    session: (id) => chats.get(id),
    openOwned: hands.openOwned,
    now: () => now,
    hourly: (r) => check.stallFor(r),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fake = { quiet: false };
  const chat = () => chats.get("w1")!;
  const push = (...blocks: Block[]) => chats.set("w1", { ...chat(), blocks: [...chat().blocks, ...blocks] });
  /** One half-minute look, as useStallWatch runs it: the hourly check first, then the stall watcher writes. */
  let step = 0;
  const look = async (at: number) => {
    now = at;
    // A working fake worker keeps reading things (its chat moves, nothing real does), unless the test hangs it.
    if (!fake.quiet && chat().busy)
      push({ id: `b${++seq}`, role: "tool", text: "Read", tool: { kind: "read", title: `Read file ${++step}`, status: "completed", detail: `${step}` } });
    await check.tick();
    watch.sync();
    watch.tick();
    await settle();
    for (const stuck of notifier.due(stuckWorkers(tracker.known(), now))) ash.push(stuck.line);
  };
  return {
    fake, backend, tracker, row, chats, chat, push, folder, commitTimes, check, look, lead, worker, ash, stopped, dropped,
    stored: () => backend.get(row.id),
    /** Move the row as another part of the app would: in the store, then this window re-reads it. */
    mutate: async (change: (row: Delegation) => void) => {
      change(backend.get(row.id));
      await tracker.refresh([row.id], "lead");
    },
    commit: () => commitTimes.push(now),
    keepTalking: (at: number) => push(said(`Still at it ${at}`)),
  };
}

describe("judging an hour", () => {
  it("counts edits, passing and failing test runs, distinct messages, the newest error run and the failing test", () => {
    const tally = tallyTranscript([
      asked(), said("a"), said("a"), said("b"), edit(), test("12 passed"), test(" FAIL  src/save.test.ts > saves > survives a restart\n2 failed, 10 passed"),
      failing("tsc: error TS2322"), failing("tsc: error TS2322"), turn(1000),
    ]);
    expect(tally).toEqual({
      edits: 1, testsPassed: 1, testsFailed: 1, messages: 2,
      errorRun: { text: "tsc: error TS2322", count: 2 },
      testRun: { name: "survives a restart", count: 1 },
    });
  });

  it("names the failing test in the words of the common runners", () => {
    expect(failingTestName(" FAIL  src/save.test.ts > saves > survives a restart")).toBe("survives a restart");
    expect(failingTestName("  × keeps the slot 12ms")).toBe("keeps the slot 12ms");
    expect(failingTestName("--- FAIL: TestSaveSlot (0.01s)")).toBe("TestSaveSlot");
    expect(failingTestName("FAILED tests/test_save.py::test_restart - AssertionError")).toBe("test_restart");
    expect(failingTestName("test save::restart ... FAILED")).toBe("save::restart");
    expect(failingTestName("1 failing\nsomething")).toBe("1 failing");
    expect(failingTestName("")).toBe("the test run");
  });

  it("a commit, a changed file or a passing test is progress; only talk passes once; the rest is stuck, saying what happened", () => {
    const none = { commits: 0, filesChanged: false, testsPassed: 0, testsFailed: 0, messages: 0 };
    expect(judgeProgress({ ...none, commits: 1 }, 0).verdict).toBe("keep_going");
    expect(judgeProgress({ ...none, filesChanged: true }, 3).verdict).toBe("keep_going");
    expect(judgeProgress({ ...none, testsPassed: 1 }, 0).verdict).toBe("keep_going");
    expect(judgeProgress({ ...none, messages: 4 }, 0)).toMatchObject({ verdict: "keep_going", talkOnly: true });
    expect(judgeProgress({ ...none, messages: 4 }, 1)).toMatchObject({ verdict: "stuck", reason: "Talked for 2 hours, no code or test changes yet" });
    expect(judgeProgress(none, 0)).toMatchObject({ verdict: "stuck", reason: "No commits, file changes or test runs for an hour" });
    expect(judgeProgress(none, 2).reason).toBe("No commits, file changes or test runs for 3 hours");
    expect(judgeProgress({ ...none, testsFailed: 3, messages: 2, failingTest: "survives a restart" }, 0).reason).toBe(
      "Tests failing for an hour, no code changes: survives a restart",
    );
    expect(judgeProgress({ ...none, commits: 2, repeatedTest: { name: "survives a restart", count: 5 } }, 0).reason).toBe(
      "Same test failing 5 times: survives a restart",
    );
    expect(judgeProgress({ ...none, commits: 2, repeatedError: { text: "ECONNREFUSED 127.0.0.1:5432", count: 6 } }, 0).reason).toBe(
      "Same error 6 times: ECONNREFUSED 127.0.0.1:5432",
    );
  });

  it("a repeated error only counts when it is new or longer since the last check", () => {
    const five = tallyTranscript(Array.from({ length: 5 }, () => failing("ECONNREFUSED")));
    const snap = (tally = five) => ({ at: 0, tally, diff: null });
    expect(progressSignals(snap(tallyTranscript([])), snap(), 0).repeatedError?.count).toBe(5);
    expect(progressSignals(snap(), snap(), 0).repeatedError).toBeUndefined();
  });

  it("the Lead's note is an app note (never Ash's words), one per row and minute", () => {
    const note = progressNoteMessage({ id: "t-1", childSession: "w1" }, "Hourly check on \"Fix\": nothing moved.", 90 * MIN);
    expect(note).toMatchObject({ id: "progress-check-t-1-90", monoNote: { kind: "message", from: "Hourly check" } });
    expect(note.text).toMatch(/^\[MonoCode hourly check\] /);
    expect(note.text).toMatch(/not a new message from Ash/);
  });
});

describe("ProgressCheck: the hour", () => {
  it("leaves a worker that commits alone: nothing said anywhere, nothing marked", async () => {
    const t = await setup();
    await t.look(0);
    t.push(edit());
    await t.look(30 * MIN);
    t.commit();
    t.keepTalking(1);
    await t.look(60 * MIN);
    t.push(test("40 passed"));
    await t.look(120 * MIN);
    expect([...t.lead, ...t.worker, ...t.ash]).toEqual([]);
    expect(t.stored().stallKind ?? null).toBeNull();
    expect(t.check.state(t.row.id)?.lastCheckAt).toBe(120 * MIN);
  });

  it("doesn't check before an hour of being seen: unknown is never stuck", async () => {
    const t = await setup();
    await t.look(5 * HOUR); // First sighting, whenever it is: only a baseline.
    await t.look(5 * HOUR + 59 * MIN);
    expect(t.lead).toEqual([]);
    expect(t.stored().stallKind ?? null).toBeNull();
  });

  it("an hour with nothing moved: the worker is asked to try another way, its Lead hears what happened, and it shows red stuck", async () => {
    const t = await setup();
    await t.look(0);
    await t.look(60 * MIN);
    expect(t.worker).toHaveLength(1);
    expect(t.worker[0]).toMatch(/^Hourly check from your Lead: no real progress toward "Saves survive a restart" \(no commits, file changes or test runs for an hour\)\. .*try a different way/);
    expect(t.lead).toEqual([
      'Hourly check on "Fix the save bug": no commits, file changes or test runs for an hour. I asked it to try another way. If it\'s still stuck in an hour, it\'s yours to stop, split or retry.',
    ]);
    expect(t.stored()).toMatchObject({ state: "running", stallKind: "loop", stallReason: "No commits, file changes or test runs for an hour · asked it to try another way" });
    // The rail: one stuck, and its red card's line is what happened.
    const rows = t.tracker.known();
    expect(shortSplit(countWork(rows, 61 * MIN)).stuck).toBe(1);
    const [stuck] = stuckWorkers(rows, 61 * MIN);
    expect(stuck).toMatchObject({ kind: "stalled", line: "No commits, file changes or test runs for an hour · asked it to try another way" });
    expect(t.ash).toEqual([]); // Its Lead's to handle: no banner.
  });

  it("hour 2: its Lead handles it by itself, without asking, and Ash isn't flagged while the Lead works on it; the red line stays", async () => {
    const t = await setup();
    await t.look(0);
    await t.look(60 * MIN);
    await t.look(120 * MIN);
    expect(t.lead[1]).toBe(
      'Hourly check on "Fix the save bug": no commits, file changes or test runs for 2 hours, after I asked it to try another way. Handle it yourself now, without asking Ash: stop it, split it into smaller pieces and brief them, or retry it with a clearer brief. Then say in one line here what you did. Only if the fix needs something only Ash can give (a key or sign-in, a delete, or a money decision), tell him in one plain line here the one thing you need.',
    );
    expect(t.ash).toEqual([]);
    expect(t.stored()).toMatchObject({ state: "running", stallKind: "loop", stallReason: "No commits, file changes or test runs for 2 hours · its Lead is on it" });
    expect(stuckWorkers(t.tracker.known(), 121 * MIN)).toHaveLength(1);
    // The Lead retries it (a message into its chat); the worker talks, nothing real moves: still not Ash's.
    t.keepTalking(1);
    await t.look(150 * MIN);
    expect(t.ash).toEqual([]);
    expect(t.stopped).toEqual([]); // The app never stops it by itself.
    expect(t.worker).toHaveLength(1); // The app's retry went once; then it's the Lead's call.
  });

  it("hour 3, still stuck after what its Lead did: its Lead is told to tell Ash, in its own chat, the one thing it needs; once", async () => {
    const t = await setup();
    await t.look(0);
    for (const h of [1, 2, 3]) await t.look(h * HOUR);
    expect(t.lead[2]).toBe(
      'Hourly check on "Fix the save bug": still stuck after what you did (no commits, file changes or test runs for 3 hours). Tell Ash now, in one plain line here: what\'s wrong and the one thing you need from him.',
    );
    expect(t.stored().stallReason).toBe("No commits, file changes or test runs for 3 hours · its Lead couldn't unstick it");
    await t.look(4 * HOUR);
    await t.look(5 * HOUR);
    expect(t.lead).toHaveLength(3); // Nobody is told again; the line keeps saying how long.
    expect(t.stored().stallReason).toBe("No commits, file changes or test runs for 5 hours · its Lead couldn't unstick it");
    expect(t.ash).toEqual([]); // Ash hears it from the Lead's chat, not from a banner.
    expect(stuckWorkers(t.tracker.known(), 5 * HOUR)).toHaveLength(1);
  });

  it("a worker without a Lead (its chat isn't an orchestrator) still raises the banner: there's no one else to tell", async () => {
    resetCodingTeamChats();
    const t = await setup();
    await t.look(0);
    await t.look(60 * MIN);
    expect(t.ash).toEqual(["No commits, file changes or test runs for an hour · asked it to try another way"]);
  });

  it("real progress clears the stuck mark within a couple of minutes, without waiting for the next hour", async () => {
    const t = await setup();
    await t.look(0);
    await t.look(60 * MIN);
    expect(t.stored().stallKind).toBe("loop");
    t.push(said("Trying the other approach"));
    await t.look(62 * MIN); // Talk alone doesn't clear it.
    expect(t.stored().stallKind).toBe("loop");
    t.folder.diff = { files: 1, additions: 12, deletions: 2 };
    await t.look(64 * MIN);
    expect(t.stored().stallKind ?? null).toBeNull();
    expect(stuckWorkers(t.tracker.known(), 65 * MIN)).toEqual([]);
    // And the next hour counts from there.
    await t.look(120 * MIN);
    expect(t.lead).toHaveLength(1);
  });

  it("only talk passes one hour; a second hour of only talk is stuck: 'Talked for 2 hours, no code or test changes yet'", async () => {
    const t = await setup();
    await t.look(0);
    t.keepTalking(1);
    await t.look(60 * MIN);
    expect(t.lead).toEqual([]);
    t.keepTalking(2);
    await t.look(120 * MIN);
    expect(t.lead[0]).toMatch(/^Hourly check on "Fix the save bug": talked for 2 hours, no code or test changes yet\./);
    expect(t.stored().stallReason).toBe("Talked for 2 hours, no code or test changes yet · asked it to try another way");
  });

  it("the same error five times in a row is stuck even though files changed, and says which error", async () => {
    const t = await setup();
    await t.look(0);
    t.push(edit(), ...Array.from({ length: 5 }, () => failing("error TS2322: Type 'string' is not assignable")));
    await t.look(60 * MIN);
    expect(t.stored().stallReason).toBe("Same error 5 times: error TS2322: Type 'string' is not assignable · asked it to try another way");
  });

  it("the same test failing five runs in a row names the test, on the card and in the Lead's note", async () => {
    const t = await setup();
    await t.look(0);
    const run = () => test(" FAIL  src/save.test.ts > saves > survives a restart\n1 failed, 11 passed");
    t.push(edit(), run(), run(), run(), run(), run());
    await t.look(60 * MIN);
    expect(t.lead[0]).toMatch(/: same test failing 5 times: survives a restart\./);
    expect(stuckWorkers(t.tracker.known(), 61 * MIN)[0].line).toBe("Same test failing 5 times: survives a restart · asked it to try another way");
  });

  it("failing tests with nothing changed are stuck; passing tests are progress", async () => {
    const t = await setup();
    await t.look(0);
    t.push(test("--- FAIL: TestSaveSlot (0.01s)"), test("--- FAIL: TestSaveSlot (0.01s)"));
    await t.look(60 * MIN);
    expect(t.lead[0]).toMatch(/: tests failing for an hour, no code changes: TestSaveSlot\./);
    t.push(test("12 passed"));
    await t.look(62 * MIN);
    expect(t.stored().stallKind ?? null).toBeNull();
  });

  it("a worker asking a question, at a usage limit, or waiting on its own workers is never checked", async () => {
    const t = await setup();
    await t.look(0);
    t.chats.set("w1", { ...t.chat(), pendingQuestion: { text: "Which save slot?" } as Session["pendingQuestion"] });
    await t.look(60 * MIN);
    await t.look(3 * HOUR - 1);
    expect(t.lead).toEqual([]);
    t.chats.set("w1", { ...t.chat(), pendingQuestion: undefined, usageLimit: { resetsAt: 0 } as Session["usageLimit"] });
    await t.look(3 * HOUR + 30 * MIN);
    expect(t.lead).toEqual([]);
    t.chats.set("w1", { ...t.chat(), usageLimit: undefined });
    await t.tracker.launch({ ownerSession: "w1", requestId: "r2", childSession: "w2" }).row;
    await t.look(5 * HOUR);
    expect(t.lead).toEqual([]);
    expect(t.stored().stallKind ?? null).toBeNull();
  });

  it("no pushes for time or cost: a six-hour, six-million-token run says nothing to anyone; its line shows how long, quietly", async () => {
    const t = await setup();
    await t.look(0);
    for (let h = 1; h <= 6; h++) {
      t.commit();
      if (h === 5) t.push(turn(4_000_000), turn(2_000_000));
      await t.look(h * HOUR);
    }
    expect([...t.ash, ...t.lead, ...t.worker]).toEqual([]);
    expect(t.stopped).toEqual([]);
    const row = { ...t.stored(), createdAt: 0 };
    expect(delegationLine(row, 6 * HOUR + 20 * MIN)).toBe("working · 6 h 20 min");
    expect(delegationLine(row, 59 * MIN)).toBe("working");
  });

  it("with no git folder it judges on the chat alone: edits are progress", async () => {
    const t = await setup({ folder: false });
    await t.look(0);
    t.push(edit());
    await t.look(60 * MIN);
    expect(t.lead).toEqual([]);
  });
});

describe("ProgressCheck: self-repair", () => {
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
      '"Fix the save bug": crashed 4 times, retries gave up: Claude exited with code 1. Handle it yourself, without asking Ash: retry it differently, split it, or stop it, then say in one line here what you did. Only if the fix needs something only Ash can give (a key or sign-in, a delete, or a money decision), tell him in one plain line here the one thing you need.',
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
    expect(t.check.state(t.row.id)?.repair?.tries).toBe(1);
    await revive(t);
    t.push(edit());
    await t.look(3 * MIN);
    await t.look(20 * MIN);
    expect(t.check.state(t.row.id)?.repair?.tries).toBe(1); // Still counting.
    await t.look(33 * MIN);
    expect(t.check.state(t.row.id)?.repair).toBeUndefined();
  });
});
