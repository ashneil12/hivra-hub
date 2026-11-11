// @vitest-environment happy-dom
// WP-171: what the app lends the worker queue for a fan-out: rows from this window, rows read back from the store after a
// restart, and what a finished provider made on disk.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { enqueueWorker, resetWorkerPool, type QueuedWorker } from "../../monos/model/workerPool";
import { forgetVerifications } from "../model/fanoutChecks";
import { parseFanout } from "../model/fanoutContract";
import { createCheckpoint, type FanoutCheckpoint } from "../model/fanoutCheckpoint";
import { planFanout, restartRequestId } from "../model/fanoutWaves";
import { currentTaskSession, fanoutHost, REFETCH_MS, tauriFileIo } from "./fanoutHost";

const platformFs = vi.hoisted(() => ({ statFiles: vi.fn(), readTextFile: vi.fn() }));
vi.mock("../../../platform/tauri/fs", () => platformFs);

const PROJECT = "/work/tally";
const FILE = `${PROJECT}/src/api/score.ts`;

const [api, board] = planFanout(
  parseFanout({
    intent: "Ash: a score board.",
    tasks: [
      { name: "api", brief: "Add the route in src/api/score.ts", goal: "it answers", owns: ["src/api/score.ts"], provides: [{ kind: "endpoint", name: "/api/score" }] },
      { name: "board", brief: "Show it in src/ui/Board.tsx", goal: "it shows", requires: ["/api/score"] },
    ],
  }),
  "mono-exo",
  "req1",
  // Sent long before the clock below: a provider the app cannot find is gone, not late to appear.
  0,
).links;
const provider = board.tasks.api.session;
const job = { id: board.tasks.board.session, fanout: board };
const queued: QueuedWorker = {
  id: board.tasks.board.session,
  ownerSession: "mono-exo",
  requestId: "req1-board",
  project: "tally",
  projectName: "Tally",
  title: "board",
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: "x", fanout: board },
};
const row = (patch: Partial<Delegation>) =>
  ({ id: "t-1", childSession: provider, state: "running", version: 1, updatedAt: 1, ...patch }) as Delegation;

function host(
  rows: Delegation[],
  options: { stored?: () => Delegation | undefined; files?: Record<string, string>; reviewing?: (session: string) => boolean } = {},
) {
  const time = { now: 1_000_000 };
  const files = options.files ?? {};
  const fetch = vi.fn(async () => options.stored?.());
  const built = fanoutHost({
    rows: () => rows,
    fetch,
    folder: (session) => (session === provider ? PROJECT : undefined),
    io: { exists: async (path) => path in files, read: async (path) => files[path] ?? null },
    now: () => time.now,
    ...(options.reviewing ? { reviewing: options.reviewing } : {}),
  });
  return { ...built, fetch, time, files };
}

beforeEach(() => {
  resetWorkerPool();
  forgetVerifications();
  platformFs.statFiles.mockReset();
  platformFs.readTextFile.mockReset();
});

describe("what the app lends the worker queue for a fan-out (WP-171)", () => {
  it("waits while the provider works, then goes once it is done and what it made is on disk", async () => {
    const rows = [row({})];
    const { dependency, settle, files } = host(rows);
    expect(dependency(job)?.reason).toBe("requires");
    Object.assign(rows[0], { state: "completed", status: "done", gateVerdict: "passed", version: 2 });
    expect(dependency(job)?.line).toMatch(/checking what api provided/);
    files[FILE] = 'app.get("/api/score", h)';
    await settle([queued]);
    expect(dependency(job)).toBeUndefined();
  });

  it("holds when what it made is not on disk", async () => {
    const rows = [row({ state: "completed", status: "done", gateVerdict: "passed", version: 2 })];
    const { dependency, settle } = host(rows);
    await settle([queued]);
    expect(dependency(job)).toMatchObject({ reason: "held" });
  });

  it("uses the newest version of a row this window has", async () => {
    const rows = [row({ version: 1 }), row({ version: 3, state: "failed", status: "failed", error: "boom" }), row({ version: 2 })];
    expect(host(rows).dependency(job)).toMatchObject({ reason: "held" });
  });

  it("reads a provider's row from the store when this window has none, for the chat that asked", async () => {
    const stored = row({ state: "completed", status: "done", gateVerdict: "passed", version: 5 });
    const { dependency, settle, fetch, files } = host([], { stored: () => stored });
    files[FILE] = "/api/score";
    expect(dependency(job)).toMatchObject({ reason: "held" }); // not found yet: not a pass
    await settle([queued]);
    expect(fetch).toHaveBeenCalledWith("mono-exo", provider);
    expect(dependency(job)).toBeUndefined();
  });

  it("never lets a row read from the store stick as running: it is read again", async () => {
    let state: Delegation = row({ version: 5 });
    const { dependency, settle, fetch, time, files } = host([], { stored: () => state });
    files[FILE] = "/api/score";
    await settle([queued]);
    expect(dependency(job)?.reason).toBe("requires");
    state = row({ state: "completed", status: "done", gateVerdict: "passed", version: 6 });
    time.now += REFETCH_MS;
    await settle([queued]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dependency(job)).toBeUndefined();
  });

  it("does not go back to the store more than once in a moment, however often the queue is looked at", async () => {
    const { settle, fetch, time } = host([], { stored: () => row({ version: 5 }) });
    await settle([queued]);
    await settle([queued]);
    await settle([queued]);
    expect(fetch).toHaveBeenCalledTimes(1);
    time.now += REFETCH_MS;
    await settle([queued]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("knows a provider that is still waiting in the queue", async () => {
    await enqueueWorker({ ...queued, id: provider, requestId: "req1-api", input: { brief: "x" } });
    expect(host([]).dependency(job)).toMatchObject({ reason: "requires" });
  });

  it("looks for a file through the app's own commands, and reads a path that is not a text file as missing", async () => {
    platformFs.statFiles.mockResolvedValueOnce([{ path: "/a", mtimeMs: 12 }]).mockResolvedValueOnce([{ path: "/b", mtimeMs: null }]);
    expect(await tauriFileIo.exists("/a")).toBe(true);
    expect(await tauriFileIo.exists("/b")).toBe(false);
    platformFs.readTextFile.mockResolvedValueOnce("text").mockRejectedValueOnce(new Error("Not a file"));
    expect(await tauriFileIo.read("/a")).toBe("text");
    expect(await tauriFileIo.read("/dir")).toBeNull();
  });

  it("is only about a plan's own providers: a task outside any fan-out has nothing to wait for", async () => {
    const { settle } = host([row({ state: "completed", status: "done", version: 2 })]);
    await expect(settle([{ ...queued, input: { brief: "x" } }])).resolves.toBeUndefined();
  });
});

describe("a provider held for its fresh-eyes review (WP-144 with WP-171)", () => {
  it("has not started yet, so what needs it waits instead of being held as lost", async () => {
    const lost = host([]);
    await lost.settle([queued]);
    expect(lost.dependency(job)).toMatchObject({ reason: "held" });
    const held = new Set([provider]);
    const reviewed = host([], { reviewing: (session) => held.has(session) });
    await reviewed.settle([queued]);
    expect(reviewed.dependency(job)).toEqual({
      reason: "requires",
      line: "Waiting for api to finish and be checked (api has not started yet). It starts by itself then.",
    });
    // Taken back, it is gone again, and what needs it is held for the first mate.
    held.clear();
    expect(reviewed.dependency(job)).toMatchObject({ reason: "held" });
  });

  // WP-172 review round 2 (HIGH): a provider stopped and started again is the one its waiting task looks for.
  it("follows a provider started again to its new chat, read from the plan's record", async () => {
    const restartedId = restartRequestId("req1", "api", 1);
    const restartedChat = `app-mono-exo-${restartedId}`;
    const plan: FanoutCheckpoint = createCheckpoint({
      id: "req1",
      owner: "mono-exo",
      waves: [["api"], ["board"]],
      tasks: [
        { name: "api", wave: 1, input: {} },
        { name: "board", wave: 2, input: {} },
      ],
      now: 0,
    });
    plan.tasks[0] = { ...plan.tasks[0], state: "started", requestId: restartedId, childSession: restartedChat };
    const checkpoints = { list: vi.fn(async () => [plan]) };
    const rows = [row({ state: "cancelled", version: 1 }), row({ id: "t-2", childSession: restartedChat, state: "running", version: 1 })];
    const files: Record<string, string> = {};
    const built = fanoutHost({
      rows: () => rows,
      fetch: vi.fn(async () => undefined),
      folder: () => PROJECT,
      io: { exists: async (path) => path in files, read: async (path) => files[path] ?? null },
      now: () => 1_000_000,
      checkpoints: () => checkpoints,
    });
    // The restarted api is running: board waits for it, not held as if api had been stopped for good.
    await built.settle([queued]);
    expect(built.dependency(job)).toMatchObject({ reason: "requires" });
    // It delivers: what it made is checked on disk, and board goes.
    Object.assign(rows[1], { state: "completed", status: "done", gateVerdict: "passed", version: 2 });
    files[FILE] = 'app.get("/api/score", h)';
    await built.settle([queued]);
    expect(built.dependency(job)).toBeUndefined();
  });

  it("reads a provider's current chat from its plan, and keeps the plan's own chat when there is no plan", async () => {
    const restartedId = restartRequestId("req1", "api", 1);
    const plan = createCheckpoint({ id: "req1", owner: "mono-exo", waves: [["api"]], tasks: [{ name: "api", wave: 1, input: {} }], now: 0 });
    const withRestart: FanoutCheckpoint = {
      ...plan,
      tasks: [{ ...plan.tasks[0], requestId: restartedId }],
    };
    expect(await currentTaskSession({ list: async () => [withRestart] }, "mono-exo", "req1", "api")).toBe(`app-mono-exo-${restartedId}`);
    // A task never started again keeps its own chat; a plan that is gone has none to give.
    expect(await currentTaskSession({ list: async () => [plan] }, "mono-exo", "req1", "api")).toBe(`app-mono-exo-f4_req1-api`);
    expect(await currentTaskSession({ list: async () => [] }, "mono-exo", "req1", "api")).toBeUndefined();
    expect(await currentTaskSession(undefined, "mono-exo", "req1", "api")).toBeUndefined();
  });
});
