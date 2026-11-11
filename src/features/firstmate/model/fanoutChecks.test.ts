import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseFanout } from "./fanoutContract";
import {
  contentProvides,
  fanoutDependency,
  forgetVerifications,
  inspectProvides,
  RECHECK_MS,
  settleFanout,
  verificationOf,
  type FileIo,
} from "./fanoutChecks";
import { planFanout, type FanoutLink, type RowView } from "./fanoutWaves";
import type { QueuedWorker } from "../../monos/model/workerPool";

const INTENT = "Ash asked for a score board with an API behind it.";
const PROJECT = "/work/tally";

/** A project on disk, as the checks read it: path to text. */
function disk(files: Record<string, string>): FileIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    exists: async (path) => path in files,
    read: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

function plan() {
  return parseFanout({
    intent: INTENT,
    tasks: [
      {
        name: "api",
        brief: "Add GET /api/score in src/api/score.ts",
        goal: "the route answers",
        owns: ["src/api/score.ts"],
        provides: [
          { kind: "endpoint", name: "/api/score" },
          { kind: "symbol", name: "ScoreService", in: "src/api/score.ts" },
          { kind: "file", name: "src/api/score.ts" },
        ],
      },
      { name: "board", brief: "Show it in src/ui/Board.tsx", goal: "the board shows it", requires: ["/api/score"] },
    ],
  });
}
const links = () => planFanout(plan(), "mono-exo", "req1").links;
const API_FILE = `${PROJECT}/src/api/score.ts`;

beforeEach(() => forgetVerifications());

describe("what a provide looks like in a file (WP-171)", () => {
  it("matches a symbol as a whole word, so HD.Ship is not HD.Shipyard", () => {
    expect(contentProvides("export const HD = { Ship: 1 }; HD.Ship.reset()", { kind: "symbol", name: "HD.Ship" })).toBe(true);
    expect(contentProvides("HD.Shipyard.reset()", { kind: "symbol", name: "HD.Ship" })).toBe(false);
    expect(contentProvides("a$HD.Ship", { kind: "symbol", name: "HD.Ship" })).toBe(false);
    expect(contentProvides("$ref + 1", { kind: "symbol", name: "$ref" })).toBe(true);
  });

  it("matches an id as the attribute, in either quote", () => {
    expect(contentProvides('<button id="launch-btn">', { kind: "id", name: "launch-btn" })).toBe(true);
    expect(contentProvides("<button id = 'launch-btn'>", { kind: "id", name: "launch-btn" })).toBe(true);
    expect(contentProvides('<button class="launch-btn">', { kind: "id", name: "launch-btn" })).toBe(false);
  });

  it("matches anything else as the literal text", () => {
    expect(contentProvides('app.get("/api/score", handler)', { kind: "endpoint", name: "/api/score" })).toBe(true);
    expect(contentProvides("process.env.SCORE_URL", { kind: "env", name: "SCORE_URL" })).toBe(true);
    expect(contentProvides("--verbose", { kind: "flag", name: "--quiet" })).toBe(false);
  });
});

describe("what a finished provider made, on disk (WP-171)", () => {
  const [api] = links();

  it("passes when every name is where the contract said it would be", async () => {
    const io = disk({ [API_FILE]: 'export class ScoreService {}\napp.get("/api/score", handler)' });
    expect(await inspectProvides("api", api.contract, PROJECT, io)).toEqual({ ok: true, problems: [] });
  });

  it("fails, and says what is missing, when a file or a name is not there", async () => {
    const empty = await inspectProvides("api", api.contract, PROJECT, disk({}));
    expect(empty.ok).toBe(false);
    expect(empty.problems).toContain("file src/api/score.ts does not exist");
    expect(empty.problems).toContain("symbol ScoreService is not in src/api/score.ts (that file is missing)");
    const partial = await inspectProvides("api", api.contract, PROJECT, disk({ [API_FILE]: "export class Other {}" }));
    expect(partial).toMatchObject({ ok: false });
    expect(partial.problems).toEqual([
      "endpoint /api/score is not in src/api/score.ts",
      "symbol ScoreService is not in src/api/score.ts",
    ]);
  });

  it("looks for a name in the file the task owns when it named no other", async () => {
    const io = disk({ [API_FILE]: 'app.get("/api/score", handler) // ScoreService' });
    expect((await inspectProvides("api", api.contract, PROJECT, io)).ok).toBe(true);
  });

  it("reads each file once, however many names are in it", async () => {
    const io = disk({ [API_FILE]: 'ScoreService /api/score' });
    await inspectProvides("api", api.contract, PROJECT, io);
    expect(io.reads).toEqual([API_FILE]);
  });

  it("never reads outside the folder it was given", async () => {
    const io = disk({});
    await inspectProvides("api", api.contract, `${PROJECT}/`, io);
    expect(io.reads.every((path) => path.startsWith(`${PROJECT}/src/`))).toBe(true);
  });

  it("fails a name nobody could look for, instead of passing it by default", async () => {
    const stored: FanoutLink = {
      ...api,
      contract: { ...api.contract, provides: [{ task: "api", kind: "symbol", name: "Nowhere" }], owners: {}, files: {} },
    };
    const out = await inspectProvides("api", stored.contract, PROJECT, disk({}));
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual(["symbol Nowhere cannot be checked: there is no file to look in"]);
  });

  it("fails when the files cannot be read at all, with the reason, never a pass", async () => {
    const broken: FileIo = {
      exists: async () => {
        throw new Error("permission denied");
      },
      read: async () => {
        throw new Error("permission denied");
      },
    };
    const out = await inspectProvides("api", api.contract, PROJECT, broken);
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toContain("permission denied");
  });
});

describe("settling a fan-out before the queue decides (WP-171)", () => {
  const [, board] = links();
  const provider = board.tasks.api.session;
  const queued = (link: FanoutLink): QueuedWorker => ({
    id: link.tasks[link.name].session,
    ownerSession: "mono-exo",
    requestId: `req1-${link.name}`,
    project: "tally",
    projectName: "Tally",
    title: link.name,
    heavy: false,
    harness: "claude",
    queuedAt: 0,
    input: { brief: "x", fanout: link },
  });
  const done: RowView = { state: "completed", status: "done", version: 3 };
  const good = 'ScoreService /api/score';

  function settleWith(
    row: RowView | undefined,
    files: Record<string, string>,
    options: { memory?: boolean; folder?: string | undefined } = {},
  ) {
    const io = disk(files);
    const fetchRow = vi.fn(async () => row);
    return {
      io,
      fetchRow,
      run: () =>
        settleFanout([queued(board)], {
          row: () => (options.memory === false ? undefined : row),
          fetchRow,
          folder: () => ("folder" in options ? options.folder : PROJECT),
          io,
        }),
    };
  }

  it("checks what a done provider made and keeps the answer for the queue to read", async () => {
    const { run } = settleWith(done, { [API_FILE]: good });
    expect(verificationOf(provider, done)).toBeUndefined();
    await run();
    expect(verificationOf(provider, done)).toEqual({ ok: true, problems: [] });
  });

  it("records a miss as a miss", async () => {
    const { run } = settleWith(done, { [API_FILE]: "nothing" });
    await run();
    expect(verificationOf(provider, done)).toMatchObject({ ok: false });
  });

  it("does not check again until the provider's row changes", async () => {
    const { run, io } = settleWith(done, { [API_FILE]: good });
    await run();
    await run();
    expect(io.reads).toEqual([API_FILE]);
    const redone = { ...done, version: 4 };
    await settleFanout([queued(board)], { row: () => redone, folder: () => PROJECT, io });
    expect(io.reads).toEqual([API_FILE, API_FILE]);
  });

  it("looks at a miss again after a while, in case the files landed since, but not before", async () => {
    const files: Record<string, string> = {};
    const io = disk(files);
    let now = 1_000;
    const run = () => settleFanout([queued(board)], { row: () => done, folder: () => PROJECT, io, now: () => now });
    await run();
    expect(verificationOf(provider, done)).toMatchObject({ ok: false });
    files[API_FILE] = good;
    now += RECHECK_MS - 1;
    await run();
    expect(verificationOf(provider, done)).toMatchObject({ ok: false });
    now += 1;
    await run();
    expect(verificationOf(provider, done)).toEqual({ ok: true, problems: [] });
    // A pass stands for that row.
    const reads = io.reads.length;
    now += 10 * RECHECK_MS;
    await run();
    expect(io.reads.length).toBe(reads);
  });

  it("leaves a provider that is still working, failed, or whose declared check did not pass alone", async () => {
    for (const row of [
      { state: "running", status: "working" },
      { state: "failed", status: "failed", error: "boom" },
      { state: "cancelled", status: "failed" },
    ] as RowView[]) {
      const { run, io } = settleWith(row, { [API_FILE]: good });
      await run();
      expect(io.reads, row.state).toEqual([]);
    }
  });

  it("reads a provider's row from the store when this window has not got it, as after a restart", async () => {
    const { run, fetchRow } = settleWith(done, { [API_FILE]: good }, { memory: false });
    const kept: [string, RowView][] = [];
    const io = disk({ [API_FILE]: good });
    await settleFanout([queued(board)], {
      row: () => undefined,
      fetchRow,
      keep: (session, row) => void kept.push([session, row]),
      folder: () => PROJECT,
      io,
    });
    expect(kept).toEqual([[provider, done]]);
    forgetVerifications();
    await run();
    expect(fetchRow).toHaveBeenCalledWith(provider, "mono-exo");
    expect(verificationOf(provider, done)).toEqual({ ok: true, problems: [] });
  });

  it("does not go to the store for a row the window already has", async () => {
    const { run, fetchRow } = settleWith(done, { [API_FILE]: good });
    await run();
    expect(fetchRow).not.toHaveBeenCalled();
  });

  it("fails what it cannot place: no known folder for the provider", async () => {
    const { run } = settleWith(done, { [API_FILE]: good }, { folder: undefined });
    await run();
    expect(verificationOf(provider, done)).toMatchObject({ ok: false });
    expect(verificationOf(provider, done)!.problems[0]).toMatch(/where api worked/);
  });

  it("skips a queued task whose link is damaged, and tasks that are not part of a fan-out", async () => {
    const io = disk({});
    const plain: QueuedWorker = { ...queued(board), input: { brief: "x" } };
    const broken: QueuedWorker = { ...queued(board), input: { brief: "x", fanout: { name: "nobody" } } };
    await expect(settleFanout([plain, broken], { row: () => done, folder: () => PROJECT, io })).resolves.toBeUndefined();
    expect(io.reads).toEqual([]);
  });
});

describe("the queue's view of a fan-out, end to end (WP-171)", () => {
  const [, board] = links();
  const provider = board.tasks.api.session;
  const job = { id: board.tasks.board.session, fanout: board };

  function view(row: RowView | undefined, queuedProvider = false) {
    return fanoutDependency({ row: () => row, queued: () => queuedProvider, verified: (session, current) => verificationOf(session, current) });
  }

  it("waits, then goes once the provider is done and what it made is on disk", async () => {
    const running: RowView = { state: "running", status: "working" };
    expect(view(running)(job)?.reason).toBe("requires");
    const done: RowView = { state: "completed", status: "done", version: 1 };
    // Done, but not looked at yet: it still waits, and says so.
    expect(view(done)(job)?.line).toMatch(/checking what api provided/);
    await settleFanout([{ ...queuedFor(board) }], {
      row: () => done,
      folder: () => PROJECT,
      io: disk({ [API_FILE]: "ScoreService /api/score" }),
    });
    expect(view(done)(job)).toBeUndefined();
  });

  it("holds when what it made is not on disk", async () => {
    const done: RowView = { state: "completed", status: "done", version: 1 };
    await settleFanout([queuedFor(board)], { row: () => done, folder: () => PROJECT, io: disk({ [API_FILE]: "" }) });
    const held = view(done)(job);
    expect(held?.reason).toBe("held");
    expect(held?.line).toContain("endpoint /api/score is not in src/api/score.ts");
  });

  it("holds a task whose stored plan cannot be read, and tells the first mate what to do", () => {
    const held = view(undefined)({ id: "x", fanout: { name: "nobody" } });
    expect(held?.reason).toBe("held");
    expect(held?.line).toMatch(/can't tell what it waits for/);
    expect(held?.line).toContain("task_cancel");
  });

  it("starts at once with no provider to wait for: the first wave", () => {
    const [first] = links();
    expect(view(undefined)({ id: first.tasks.api.session, fanout: first })).toBeUndefined();
  });

  it("knows a provider that is still queued", () => {
    expect(view(undefined, true)(job)?.reason).toBe("requires");
    expect(provider).toContain("req1-api");
  });

  function queuedFor(link: FanoutLink): QueuedWorker {
    return {
      id: link.tasks[link.name].session,
      ownerSession: "mono-exo",
      requestId: `req1-${link.name}`,
      project: "tally",
      projectName: "Tally",
      title: link.name,
      heavy: false,
      harness: "claude",
      queuedAt: 0,
      input: { brief: "x", fanout: link },
    };
  }
});
