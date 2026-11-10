import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import { handleWithBriefParts } from "../../firstmate/testing/briefParts";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { Delegation, DelegationsBackend } from "../../monos/model/delegations";
import { forgetAshAnswers, noteAshAnswer } from "../../monos/model/ashAnswersWorker";
import { delegationTasksHost } from "../../monos/model/delegationTasks";
import { newSession, type Session } from "../../sessions/model/session";
import { fakeInbox, FINDING, testClock } from "../testing/world";
import { setFreshEyesPort } from "./bind";
import { answerFreshEyes, heldWaiting, releaseHeld, START_BACKOFF_MS, syncHeldDecisions } from "./gate";
import { bindFreshEyesBackend, bindHeldStarter, resetHeld } from "./held";
import type { ReviewerPort, ReviewerTurn } from "./review";
import { createEyesStorage, reviewFor, setFreshEyesStorage, writeSetting } from "./store";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

const PROJECT = "/tmp/fresh-eyes-project";

let warn: ReturnType<typeof vi.spyOn>;
afterEach(() => {
  warn?.mockRestore();
  forgetAshAnswers();
  setFreshEyesStorage(undefined);
  setFreshEyesPort(undefined);
  resetHeld();
  vi.useRealTimers();
});

describe("fresh-eyes before a builder starts", () => {
  it("does not start a builder while the review is waiting", async () => {
    const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
    const start = vi.fn(async () => undefined);
    const tasks = {
      owned: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      nextChange: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ stopFailed: [] })),
      freshEyes: vi.fn(async () => ({ hold: true, why: "Fresh-eyes review: 2 findings, waiting on you" })),
    } as unknown as AgentAppTasksHost;
    const host = {
      start,
      sessions: vi.fn(async () => []),
      session: vi.fn(async () => null),
      send: vi.fn(async () => ({ alreadySubmitted: false })),
      draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
      createWorktree: vi.fn(),
      notes: vi.fn(async () => []),
      note: vi.fn(async () => null),
      saveNote: vi.fn(),
      isMono: () => true,
      monoOf: () => ({ id: "lead", name: "Lead", projects: [PROJECT] }),
      tasks,
    } as unknown as AgentAppHost;

    const result = await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      freshEyes: true,
      note: "Fresh-eyes review: 2 findings, waiting on you",
      status: "waiting",
      childSessionId: "app-mono-lead-r1",
    });
  });

  it("with the setting on, delegate is held as a waiting task and Approve starts a worker", async () => {
    const world = await heldWorld();
    const { source, rows, start, host, storage } = world;

    const result = (await handleWithBriefParts(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug.", reading: [{ path: "src/note.ts", text: "save()" }] },
      host,
    )) as { status?: string; childSessionId?: string; freshEyes?: boolean; taskId?: string | null };

    // Waiting, with no worker and no delegation row yet.
    expect(result).toMatchObject({ status: "waiting", freshEyes: true, childSessionId: "app-mono-lead-r1", taskId: null });
    expect(start).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    const before = (await handleWithBriefParts(source, "s1", "tasks.status", {}, host)) as StatusAnswer;
    expect(before.tasks).toEqual([]);
    expect(before.waiting).toEqual([
      expect.objectContaining({ childSessionId: "app-mono-lead-r1", status: "waiting", freshEyes: true }),
    ]);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });

    // One worker started under the same chat, and its delegation row is running with that child session.
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toBe("app-mono-lead-r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", childSession: "app-mono-lead-r1" });
    const after = (await handleWithBriefParts(source, "s2", "tasks.status", {}, host)) as StatusAnswer;
    expect(after.tasks).toEqual([expect.objectContaining({ childSessionId: "app-mono-lead-r1", status: "running" })]);
    expect(after.waiting).toBeUndefined();
    const kept = reviewFor(PROJECT, "r1", storage);
    expect(kept).toMatchObject({ status: "approved", launched: true });
    expect(kept?.held).toBeUndefined();
  });

  it("returns before the reviewers answer: well under the 40 second MCP hop while they are slow", async () => {
    vi.useFakeTimers();
    const world = await heldWorld({ reviewerMs: 120_000 });
    const { source, host, start, storage } = world;
    const begun = Date.now();
    let answered: unknown;
    const call = handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host).then((value) => {
      answered = value;
    });
    // No clock time passes: the reviewers (two minutes each) cannot be what the call waits on.
    await vi.advanceTimersByTimeAsync(0);
    await call;
    expect(Date.now() - begun).toBeLessThan(1_000);
    expect(answered).toMatchObject({ status: "waiting", freshEyes: true, note: "Fresh-eyes review: still running" });
    expect(world.reviewed).toBe(1);
    expect(reviewFor(PROJECT, "r1", storage)?.findings).toEqual([]);

    // The review finishes in the background and the brief is still waiting on the person.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(world.reviewed).toBe(2);
    expect(reviewFor(PROJECT, "r1", storage)?.findings.length).toBeGreaterThan(0);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");
    expect(start).not.toHaveBeenCalled();
  });

  it("passes the reading list through to the held brief, the reviewers and the start, capped", async () => {
    const world = await heldWorld();
    const { source, host, storage } = world;
    const reading = [{ path: "src/note.ts", text: "save()" }];
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug.", reading }, host);

    expect(reviewFor(PROJECT, "r1", storage)?.held).toMatchObject({ brief: "Fix the save bug.", reading });
    expect(world.port.seen.some((turn) => turn.prompt.includes("src/note.ts") && turn.prompt.includes("save()"))).toBe(true);

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(world.started).toHaveLength(1);
    expect(world.started[0]).toMatchObject({ requestId: "r1", input: { reading } });

    // A reading list of any size is cut to eight short entries before anything keeps it.
    const long = Array.from({ length: 20 }, (_, n) => ({ path: `src/file-${n}.ts`, text: "x".repeat(50_000) }));
    await handleWithBriefParts(source, "r2", "tasks.delegate", { brief: "Another job.", reading: long }, host);
    const held = reviewFor(PROJECT, "r2", storage)?.held as { reading: { text: string }[] };
    expect(held.reading).toHaveLength(8);
    expect(held.reading.every((entry) => entry.text.length <= 8_000)).toBe(true);
  });

  it("a review that finishes after Approve neither starts a second worker nor undoes the decision", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(start).toHaveBeenCalledTimes(1);

    world.port.release("FINDING: Late.\nBREAK: The review finished after Approve.");
    await vi.waitFor(() => expect(reviewFor(PROJECT, "r1", storage)?.running).toBeUndefined());
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("approved");
    expect(reviewFor(PROJECT, "r1", storage)?.findings).toEqual([]);
  });

  it("Skip once starts the held brief too, and a double click starts it once", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await Promise.all([
      answerFreshEyes(PROJECT, "r1", "Skip once", { storage }),
      answerFreshEyes(PROJECT, "r1", "Skip once", { storage }),
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "skipped_by_person", launched: true });
  });

  it("Edit plan does not start the brief", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await answerFreshEyes(PROJECT, "r1", "Edit plan", { storage });
    await releaseHeld({ storage });
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("editing");
  });

  it("starts the edit that was reviewed, not the brief the person first saw", async () => {
    const world = await heldWorld({ answer: FINDING });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await world.reviewsDone("r1");
    await answerFreshEyes(PROJECT, "r1", "Edit plan", { storage });

    // The first mate sends the edit under the same request ID. It is held and reviewed; nothing starts.
    const again = await handleWithBriefParts(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Rename the note button and keep the cursor." },
      host,
    );
    expect(again).toMatchObject({ status: "waiting", freshEyes: true });
    expect(start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reviewFor(PROJECT, "r1", storage)?.held?.brief).toBe("Rename the note button and keep the cursor."));
    await world.reviewsDone("r1");

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(start).toHaveBeenCalledTimes(1);
    const launched = JSON.stringify(start.mock.calls[0]?.[0]);
    expect(launched).toContain("keep the cursor");
    expect(launched).not.toContain("Fix the save bug");
  });

  it("does not start another brief under the id of an approved one whose start failed", async () => {
    const world = await heldWorld({ startFails: true, answer: FINDING });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await world.reviewsDone("r1");
    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", startFailures: 1 });

    // The retry carries something else under the same ID: it is a new brief, so it is held and reviewed.
    const other = await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Delete every note." }, host);
    expect(other).toMatchObject({ status: "waiting", freshEyes: true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.held?.brief).toBe("Delete every note.");
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");
  });

  it("holds before anything starts or a team is made, and refuses a call that would fail before it is reviewed", async () => {
    const monoWork = {
      isLead: () => false,
      codingTeam: () => undefined,
      ownTeam: vi.fn(async () => ({ folder: "/tmp/fresh-eyes-team", name: "Team" })),
    };
    const world = await heldWorld({ monoWork });
    const { source, host, storage } = world;
    source.firstMate = true;
    const refused: [string, Record<string, unknown>, RegExp][] = [
      ["a1", { isolation: "shared" }, /own, never the project's main one|checkout of their own/],
      ["a2", { isolation: "sideways" }, /isolation must be/],
      ["a3", { whenBusy: "queue" }, /whenBusy is for a brief to a Lead/],
      ["a4", { heavy: "yes" }, /heavy must be true or false/],
      ["a5", { gates: "all of them" }, /gates must be a list/],
      ["a6", { model: "no-such-model-anywhere" }, /./],
    ];
    for (const [id, extra, why] of refused) {
      await expect(
        handleWithBriefParts(source, id, "tasks.delegate", { brief: "Fix the save bug.", ...extra }, host),
      ).rejects.toThrow(why);
      expect(reviewFor(PROJECT, id, storage)).toBeNull();
    }
    expect(world.port.seen).toEqual([]);

    // A good call is held, and the Mono's team is not made until the brief may start.
    const good = await handleWithBriefParts(source, "g1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(good).toMatchObject({ status: "waiting", freshEyes: true });
    expect(monoWork.ownTeam).not.toHaveBeenCalled();
    await answerFreshEyes(PROJECT, "g1", "Approve", { storage });
    expect(monoWork.ownTeam).toHaveBeenCalledTimes(1);
    expect(world.start).toHaveBeenCalledTimes(1);
  });

  it("refuses plainly when the hold cannot be saved, and starts and holds nothing", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    world.breakWrites();
    await expect(
      handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host),
    ).rejects.toThrow(/could not be saved, so this brief was not started or held/);
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)).toBeNull();
    const status = (await handleWithBriefParts(source, "s1", "tasks.status", {}, host)) as StatusAnswer;
    expect(status.waiting).toBeUndefined();
  });

  it("a brief held before a restart still starts when it is approved afterwards", async () => {
    const world = await heldWorld();
    const { source, host, start } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    // The app restarts: everything in memory is gone. The review record, in the app's database, is not.
    resetHeld();
    setFreshEyesPort(undefined);
    const restarted = createEyesStorage(world.disk, { windowId: "w2" });
    setFreshEyesStorage(restarted);
    bindFreshEyesBackend(world.inbox);
    world.bindStarter();

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage: restarted });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toBe("app-mono-lead-r1");
  });

  it("waits for the chat that asked to be open, then starts once", async () => {
    const world = await heldWorld({ open: false });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)?.launched).toBeUndefined();

    world.openChat();
    await releaseHeld({ storage });
    await releaseHeld({ storage });
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.launched).toBe(true);
  });

  it("an answer given in the Inbox by the person starts the held brief, and a chat's answer does not", async () => {
    const world = await heldWorld({ answer: FINDING });
    const { source, host, start, storage, inbox } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await world.reviewsDone("r1");
    const key = reviewFor(PROJECT, "r1", storage)!.key!;
    expect(inbox.asked.map((entry) => entry.key)).toEqual([key]);

    await syncHeldDecisions({ storage });
    expect(start).not.toHaveBeenCalled();
    // The first mate answers ask_person on the review's key and says "Approve": that is not the person.
    inbox.reply(key, "Approve", "chat:mono-lead");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await syncHeldDecisions({ storage });
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");
    // The same row, answered by the person in the Inbox.
    inbox.rows.find((row) => row.decisionKey === key)!.answeredBy = "user";
    await syncHeldDecisions({ storage });
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", launched: true });
  });

  it("task_cancel takes a held brief back, closes its question, and Approve then starts nothing", async () => {
    const world = await heldWorld({ answer: FINDING });
    const { source, host, start, storage, inbox } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await world.reviewsDone("r1");
    const key = reviewFor(PROJECT, "r1", storage)!.key!;

    const cancelled = await handleWithBriefParts(source, "c1", "tasks.cancel", { taskId: "app-mono-lead-r1" }, host);
    expect(cancelled).toMatchObject({ taskId: "app-mono-lead-r1", status: "cancelled" });
    const status = (await handleWithBriefParts(source, "s1", "tasks.status", {}, host)) as StatusAnswer;
    expect(status.waiting).toBeUndefined();
    expect(inbox.rows.find((row) => row.decisionKey === key)?.state).toBe("answered");

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    await releaseHeld({ storage });
    expect(start).not.toHaveBeenCalled();
    expect((await heldWaiting("mono-lead", { storage })).length).toBe(0);
  });

  it("a start that throws is tried again after a wait, and the chat and the person are told when it never works", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const clock = testClock();
    const world = await heldWorld({ startFails: true, clock });
    const { source, host, start, storage, inbox } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(start).toHaveBeenCalledTimes(1);
    for (const wait of START_BACKOFF_MS) {
      await releaseHeld({ storage });
      expect(start.mock.calls.length).toBeGreaterThan(0);
      clock.advance(wait + 1);
      await releaseHeld({ storage });
    }
    expect(start).toHaveBeenCalledTimes(START_BACKOFF_MS.length + 1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", startGaveUp: true });
    expect(reviewFor(PROJECT, "r1", storage)?.held).toBeDefined();
    expect(inbox.told).toHaveLength(1);
    expect(inbox.told[0]).toMatchObject({ owner: "mono-lead" });
    expect(inbox.asked.some((entry) => entry.key.startsWith("fresh-eyes-start/"))).toBe(true);
    clock.advance(60 * 60_000);
    await releaseHeld({ storage });
    expect(start).toHaveBeenCalledTimes(START_BACKOFF_MS.length + 1);
  });
});

describe("the hold comes after every refusal", () => {
  it("returns every refusal of a brief to a Lead before anything is held, and holds a good one", async () => {
    const world = await heldWorld();
    const { source, host, storage } = world;
    const refused: [string, Record<string, unknown>, RegExp][] = [
      ["l1", { lead: "lead-1", project: "/tmp/other" }, /leave out project/],
      ["l2", { lead: "lead-1", model: "claude:haiku-4.5" }, /leave out model/],
      ["l3", { lead: "lead-1", effort: "high" }, /leave out effort/],
      ["l4", { lead: "lead-1", isolation: "worktree" }, /leave out isolation/],
      ["l5", { lead: "lead-1", whenBusy: "later" }, /whenBusy must be "queue" or "steer"/],
      ["l6", { lead: "nobody" }, /No Lead "nobody"/],
      ["l7", { lead: "" }, /lead/],
    ];
    for (const [id, extra, why] of refused) {
      await expect(handleWithBriefParts(source, id, "tasks.delegate", { brief: "Fix the save bug.", ...extra }, host)).rejects.toThrow(why);
      expect(reviewFor(PROJECT, id, storage)).toBeNull();
    }
    expect(world.port.seen).toEqual([]);
    expect(world.briefLead).not.toHaveBeenCalled();
    expect(storage.snapshot().reviews).toEqual([]);

    const good = await handleWithBriefParts(source, "l9", "tasks.delegate", { brief: "Fix the save bug.", lead: "lead-1", whenBusy: "steer" }, host);
    expect(good).toMatchObject({ status: "waiting", freshEyes: true });
    expect(world.briefLead).not.toHaveBeenCalled();
    await answerFreshEyes(PROJECT, "l9", "Approve", { storage });
    expect(world.briefLead).toHaveBeenCalledTimes(1);
  });

  it("returns the refusal of a job Ash already answered before anything is held", async () => {
    const world = await heldWorld();
    const { source, host, storage, rows } = world;
    // Ash answered the worker of "Fix the save bug" in its own chat, and it is still open.
    rows.push({ ...startedRow("app-mono-lead-first", "mono-lead"), id: "t-open", title: "Fix the save bug." });
    noteAshAnswer("t-open", "keep them for 30 days");

    await expect(handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host)).rejects.toThrow(
      /Ash already answered/,
    );
    expect(reviewFor(PROJECT, "r1", storage)).toBeNull();
    expect(world.port.seen).toEqual([]);
    // It is turned back once; a second call that really is other work goes on to its review.
    const again = await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(again).toMatchObject({ status: "waiting", freshEyes: true });
  });
});

describe("a brief that started is spent", () => {
  async function started() {
    const world = await heldWorld({ answer: FINDING });
    const { source, host, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await world.reviewsDone("r1");
    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    expect(world.start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", launched: true });
    return world;
  }

  it("is not started again by an approval it already used, after the worker was cancelled and the app restarted", async () => {
    const world = await started();
    const { source, host, rows, start } = world;
    rows[0].state = "cancelled";

    // The app restarts: the record, in the database, is all that is left. The same brief under the same ID comes again.
    resetHeld();
    const restarted = createEyesStorage(world.disk, { windowId: "w2" });
    setFreshEyesStorage(restarted);
    bindFreshEyesBackend(world.inbox);
    world.bindStarter();
    const again = await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(again).toMatchObject({ status: "waiting", freshEyes: true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", restarted)).toMatchObject({ status: "pending" });
    expect(reviewFor(PROJECT, "r1", restarted)?.launched).toBeUndefined();
  });

  it("still reads back a worker that is running, without a new review", async () => {
    const world = await started();
    const { source, host, start, port } = world;
    const seen = port.seen.length;
    const again = await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(again).toMatchObject({ alreadyStarted: true, childSessionId: "app-mono-lead-r1" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(port.seen.length).toBe(seen);
  });
});

describe("a reading list keeps the same hash through a restart", () => {
  it("starts a brief whose reading is cut at a space, because the call that starts it is the call that was reviewed", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    const reading = [{ path: "src/a.ts", text: `${"x".repeat(7_999)} ${"y".repeat(100)}` }];
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug.", reading }, host);
    const hash = reviewFor(PROJECT, "r1", storage)!.hash;

    await answerFreshEyes(PROJECT, "r1", "Approve", { storage });
    // The start asks again with what was kept. It is the same call: it is not held for a second review.
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", launched: true, hash });
  });
});

type StatusAnswer = { tasks: Record<string, unknown>[]; waiting?: Record<string, unknown>[] };

/**
 * A project with the review on, the real delegation host over a fake store, and reviewers that answer after
 * `reviewerMs` (or never, until the test lets them go). `start` stands for the app starting a worker chat: it records the
 * delegation row the app would write.
 */
async function heldWorld(
  options: {
    reviewerMs?: number;
    answer?: string;
    open?: boolean;
    startFails?: boolean;
    clock?: ReturnType<typeof testClock>;
    monoWork?: NonNullable<Parameters<typeof delegationTasksHost>[0]["monoWork"]>;
  } = {},
) {
  // A brief to a Lead: the app's own checks and start, as App.tsx has them.
  const briefLead = vi.fn(async () => ({ row: null, childSessionId: "lead-chat", delivery: "started" as const, leadName: "Lead" }));
  const checkLead = vi.fn((_source: Session, _mono: { id: string }, lead: string) => {
    if (lead !== "lead-1") throw new Error(`No Lead "${lead}" among the ones you can brief.`);
  });
  const base = memoryDisk();
  let failing = false;
  const disk = {
    ...base,
    write: async (key: string, value: unknown, rev?: number) => {
      if (failing) throw new Error("The disk is full.");
      return base.write(key, value, rev);
    },
  };
  const storage = createEyesStorage(disk, { windowId: "w1", ...(options.clock ? { now: options.clock.now } : {}) });
  setFreshEyesStorage(storage);
  await writeSetting(PROJECT, { enabled: true }, storage);
  const inbox = fakeInbox();
  bindFreshEyesBackend(inbox);

  const seen: ReviewerTurn[] = [];
  let reviewed = 0;
  let release: (text: string) => void = () => undefined;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const port: ReviewerPort & { seen: ReviewerTurn[]; release(text: string): void } = {
    seen,
    release: (text) => release(text),
    ask: async (turn) => {
      seen.push(turn);
      reviewed += 1;
      if (options.reviewerMs) {
        return new Promise<string>((resolve) => setTimeout(() => resolve(FINDING), options.reviewerMs));
      }
      return options.answer !== undefined ? options.answer : gate;
    },
  };
  setFreshEyesPort(port);

  const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
  const rows: Delegation[] = [];
  const start = vi.fn(async (_launch: unknown, id: string, _draft: unknown, notify: string) => {
    if (options.startFails) throw new Error("The worker could not start.");
    rows.push(startedRow(id, notify));
  });
  const tasks = delegationTasksHost({
    backend: backend(rows),
    tracker: () => null,
    session: () => source,
    stop: async () => undefined,
    dropReport: () => undefined,
    ...(options.monoWork ? { monoWork: options.monoWork } : {}),
    briefLead,
    checkLead,
  });
  const host = appHost(source, start, tasks);
  const started: { owner: string; requestId: string; input: Record<string, unknown> }[] = [];
  let open = options.open !== false;
  // The app's own start: tasks.delegate asked again under the same request ID.
  const bindStarter = () =>
    bindHeldStarter({
      canStart: () => open,
      start: (owner, requestId, input) => {
        started.push({ owner, requestId, input });
        return handleWithBriefParts(source, requestId, "tasks.delegate", input, host);
      },
    });
  bindStarter();
  return {
    disk: base,
    storage,
    source,
    rows,
    start,
    host,
    port,
    inbox,
    started,
    briefLead,
    checkLead,
    bindStarter,
    breakWrites: () => {
      failing = true;
    },
    openChat: () => {
      open = true;
    },
    /** The reviewers have answered for this request and the person has been asked. */
    reviewsDone: (requestId: string) =>
      vi.waitFor(() => {
        const row = reviewFor(PROJECT, requestId, storage);
        expect(row?.running).toBeUndefined();
        expect(row?.asked).toBe(true);
      }),
    get reviewed() {
      return reviewed;
    },
  };
}

function startedRow(id: string, owner: string): Delegation {
  return {
    id: "t-held",
    ownerSession: owner,
    ownerMono: "lead",
    batchId: null,
    parentId: null,
    rootId: "t-held",
    childSession: id,
    requestId: id,
    generation: 1,
    project: PROJECT,
    title: "Fix the save bug.",
    brief: "Fix the save bug.",
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
  };
}

function backend(rows: Delegation[]): DelegationsBackend {
  return {
    owned: async (query) => {
      const mine = rows.filter((row) => row.ownerSession === query.ownerSession);
      if (!query.ids?.length && !query.requestIds?.length) {
        return mine.filter((row) => row.state === "running" || row.state === "question");
      }
      return mine.filter((row) => query.ids?.includes(row.id) || query.requestIds?.includes(row.requestId));
    },
    listOpen: async () => rows,
    tree: async () => [],
    record: async () => {
      throw new Error("not used");
    },
    settle: async () => ({ applied: false, row: null }),
    reattach: async () => null,
    setQuestion: async () => ({ applied: false, row: null }),
    setDelivery: async () => [],
    cancel: async () => [],
    refuse: async () => ({ applied: false, row: null }),
    reportsSeen: async () => [],
    bindChat: async () => false,
  };
}

function appHost(source: Session, start: AgentAppHost["start"], tasks: AgentAppTasksHost): AgentAppHost {
  return {
    start,
    sessions: vi.fn(async () => []),
    session: vi.fn(async () => null),
    send: vi.fn(async () => ({ alreadySubmitted: false })),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
    createWorktree: vi.fn(),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(),
    isMono: () => true,
    monoOf: () => ({ id: "lead", name: "Lead", projects: [source.cwd], team: "/tmp/fresh-eyes-team" }),
    tasks,
  } as unknown as AgentAppHost;
}
