// The PR watch's webview side (prWatches.ts, prWatchJobs.ts): a stored wake reaches its owner's chat exactly once,
// across restarts, as an app notification; the board's words for a watch. The store is a stand-in with pr_watch.rs's
// forward-only delivery rule.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { newSession, type QueuedMessage, type Session } from "../../sessions/model/session";
import {
  CHECKS_FAILED_SUMMARY,
  PrWatchTracker,
  ciRedEvent,
  loadOwner,
  prWatchLine,
  waitingActivity,
  wakeMessage,
  type PrWake,
  type PrWakeDelivery,
  type PrWatch,
  type PrWatchBackend,
} from "./prWatches";
import { prWatchWorkers } from "./prWatchJobs";

function wake(patch: Partial<PrWake> & Pick<PrWake, "id">): PrWake {
  return {
    watchId: "w1",
    ownerSession: "mono-hivra",
    seq: 1,
    kind: "update",
    title: "PR #42: checks failed",
    outcome: "failed",
    text: "[MonoCode PR watch] Update on pull request #42 ...",
    delivery: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function watch(patch: Partial<PrWatch> = {}): PrWatch {
  return {
    id: "w1",
    ownerSession: "mono-hivra",
    ownerMono: "hivra-lead",
    ownerName: "Hivra lead",
    repo: "ashneil12/hivra",
    number: 42,
    url: "https://github.com/ashneil12/hivra/pull/42",
    title: "Fix the save bug",
    project: "hivra",
    worktree: "/w/hivra-pr-42",
    repoRoot: "/code/hivra",
    askIds: [],
    state: "watching",
    endReason: null,
    status: {
      pr: "open",
      draft: false,
      required: true,
      checks: 3,
      pending: 1,
      failed: [],
      passed: false,
      mergeable: "mergeable",
      reviewDecision: null,
    },
    headSha: "abc",
    headRef: "fix",
    baseRef: "main",
    mergeSha: null,
    readFailures: 0,
    lastError: null,
    lastReadAt: 600_000,
    nextReadAt: 720_000,
    wakesTotal: 0,
    createdAt: 0,
    updatedAt: 600_000,
    endedAt: null,
    ...patch,
  };
}

const RANK: Record<PrWakeDelivery, number> = { pending: 0, queued: 1, delivered: 2, disposed: 3 };

function backend(wakes: PrWake[], transcript: Record<string, string[]> = {}) {
  const removed: unknown[] = [];
  const api: PrWatchBackend = {
    add: vi.fn(),
    remove: vi.fn(async (input) => {
      removed.push(input);
      return [];
    }),
    list: vi.fn(async () => []),
    wakesOpen: vi.fn(async () => wakes.filter((w) => w.delivery === "pending" || w.delivery === "queued")),
    setDelivery: vi.fn(async (ids, delivery) =>
      wakes.filter((w) => {
        if (!ids.includes(w.id) || w.delivery === "disposed" || RANK[delivery] <= RANK[w.delivery]) return false;
        w.delivery = delivery;
        return true;
      }),
    ),
    seen: vi.fn(async (owner, ids) => ids.filter((id) => transcript[owner]?.includes(id))),
  };
  return { api, removed };
}

function host(sessions: Session[], monos = ["mono-hivra"]) {
  const queued: Array<[string, QueuedMessage]> = [];
  return {
    queued,
    host: {
      isMono: (id: string) => monos.includes(id),
      load: async (id: string) => sessions.find((s) => s.id === id) ?? null,
      queueWake: vi.fn(async (owner: string, message: QueuedMessage) => {
        queued.push([owner, message]);
        const session = sessions.find((s) => s.id === owner);
        if (session) session.queuedMessages = [...(session.queuedMessages ?? []), message];
      }),
    },
  };
}

function mono(id = "mono-hivra"): Session {
  return { ...newSession("claude", "/code/hivra", "claude:opus-5-5"), id };
}

describe("delivering wakes", () => {
  it("queues a pending wake as an app notification, marked queued first, then delivered when it goes out", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1" })];
    const store = backend(wakes);
    const app = host([mono()]);
    const tracker = new PrWatchTracker(store.api, app.host);
    expect(await tracker.deliver()).toEqual({ queued: 1, delivered: 0, dropped: 0 });
    expect(app.queued).toEqual([
      [
        "mono-hivra",
        {
          id: "pr-watch-w1-1",
          text: "[MonoCode PR watch] Update on pull request #42 ...",
          attachments: [],
          monoSessionCompletion: { sessionId: "w1", title: "PR #42: checks failed", status: "failed" },
        },
      ],
    ]);
    expect(wakes[0].delivery).toBe("queued");
    // The queue's dispatcher sent it: delivered. A report id of a delegation is none of this tracker's business.
    tracker.delivered("mono-completion-r1-g1");
    tracker.delivered("pr-watch-w1-1");
    await tracker.deliver();
    expect(wakes[0].delivery).toBe("delivered");
    expect(store.api.setDelivery).not.toHaveBeenCalledWith(["mono-completion-r1-g1"], expect.anything());
    expect(app.queued).toHaveLength(1);
  });

  it("after a restart: a wake already in the transcript is delivered, one in the queue waits, a lost one is queued again", async () => {
    const wakes = [
      wake({ id: "pr-watch-w1-1", delivery: "queued" }),
      wake({ id: "pr-watch-w1-2", seq: 2, delivery: "queued" }),
      wake({ id: "pr-watch-w1-3", seq: 3, delivery: "queued" }),
    ];
    const store = backend(wakes, { "mono-hivra": ["pr-watch-w1-1"] });
    const owner = mono();
    owner.queuedMessages = [wakeMessage(wakes[1])];
    const app = host([owner]);
    const summary = await new PrWatchTracker(store.api, app.host).deliver();
    expect(summary).toEqual({ queued: 1, delivered: 1, dropped: 0 });
    expect(wakes.map((w) => w.delivery)).toEqual(["delivered", "queued", "queued"]);
    expect(app.queued.map(([, message]) => message.id)).toEqual(["pr-watch-w1-3"]);
  });

  it("drops the wakes of a chat that is gone and ends its watches", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1", ownerSession: "deleted-chat" }), wake({ id: "pr-watch-w2-1", watchId: "w2" })];
    const store = backend(wakes);
    const app = host([mono()]);
    expect(await new PrWatchTracker(store.api, app.host).deliver()).toEqual({ queued: 1, delivered: 0, dropped: 1 });
    expect(wakes[0].delivery).toBe("disposed");
    expect(store.removed).toEqual([{ ownerSession: "deleted-chat", reason: "owner-gone" }]);
    expect(app.queued.map(([owner]) => owner)).toEqual(["mono-hivra"]);
  });

  it("a chat that can't be read right now keeps its wakes and watches for the next round", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1" }), wake({ id: "pr-watch-w1-2", seq: 2 })];
    const store = backend(wakes);
    const app = host([mono()]);
    let failing = true;
    let reads = 0;
    const flaky = {
      ...app.host,
      // The app's real read: the chat as this window has it, else the store, which is busy for a moment.
      load: (id: string) =>
        loadOwner([], id, async (wanted) => {
          reads++;
          if (failing) throw new Error("database is locked");
          return app.host.load(wanted);
        }),
    };
    const tracker = new PrWatchTracker(store.api, flaky);
    expect(await tracker.deliver()).toEqual({ queued: 0, delivered: 0, dropped: 0, waiting: 1 });
    expect(reads).toBe(1);
    expect(wakes.map((w) => w.delivery)).toEqual(["pending", "pending"]);
    expect(store.removed).toEqual([]);
    expect(store.api.setDelivery).not.toHaveBeenCalled();
    failing = false;
    expect(await tracker.deliver()).toEqual({ queued: 2, delivered: 0, dropped: 0 });
    expect(wakes.map((w) => w.delivery)).toEqual(["queued", "queued"]);
  });

  it("only a chat the store really doesn't have is gone", async () => {
    expect(await loadOwner([], "mono-hivra", async () => null)).toBeNull();
    const open = mono();
    expect(await loadOwner([open], "mono-hivra", async () => null)).toBe(open);
    await expect(loadOwner([], "mono-hivra", async () => Promise.reject(new Error("busy")))).rejects.toThrow("busy");
  });

  it("a wake Ash deletes from the queue is not owed any more", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1", delivery: "queued" })];
    const store = backend(wakes);
    const tracker = new PrWatchTracker(store.api, host([mono()]).host);
    tracker.discarded("pr-watch-w1-1");
    tracker.discarded("proof-msg-async");
    await tracker.deliver();
    expect(wakes[0].delivery).toBe("disposed");
    expect(store.api.setDelivery).toHaveBeenCalledTimes(1);
  });

  it("a passing or merged wake reads as completed in the queue", () => {
    expect(wakeMessage(wake({ id: "x", outcome: "completed", title: "PR #42: merged" })).monoSessionCompletion).toEqual({
      sessionId: "w1",
      title: "PR #42: merged",
      status: "completed",
    });
    expect(wakeMessage(wake({ id: "y", outcome: "updated" })).monoSessionCompletion?.status).toBe("completed");
  });
});

describe("the board", () => {
  it("says how many commits behind main a green pull request is (WP-202)", () => {
    const s = watch().status;
    const green = { ...s, pending: 0, passed: true, failed: [] };
    expect(prWatchLine(watch({ status: { ...green, behind: 3 } }))).toBe("Checks passed; 3 commits behind main");
    expect(prWatchLine(watch({ status: { ...green, behind: 1 } }))).toBe("Checks passed; 1 commit behind main");
    expect(prWatchLine(watch({ status: { ...green, behind: 0 } }))).toBe("Checks passed; waiting to merge");
  });

  it("says where the pull request stands in a few words", () => {
    const s = watch().status;
    expect(prWatchLine(watch())).toBe("2 of 3 required checks done");
    expect(prWatchLine(watch({ status: { ...s, pending: 0, failed: ["a", "b"] } }))).toBe("2 required checks failed");
    expect(prWatchLine(watch({ status: { ...s, required: false, pending: 0, failed: ["a"] } }))).toBe("1 check failed");
    expect(prWatchLine(watch({ status: { ...s, mergeable: "conflicting" } }))).toBe("Conflicts with its base branch");
    expect(prWatchLine(watch({ status: { ...s, checks: 0, pending: 0 } }))).toBe("Waiting for checks to start");
    expect(prWatchLine(watch({ status: { ...s, pending: 0, passed: true, reviewDecision: "REVIEW_REQUIRED" } }))).toBe(
      "Checks passed; waiting for review",
    );
    expect(prWatchLine(watch({ state: "ended", endReason: "merged" }))).toBe("Merged");
    expect(prWatchLine(watch({ state: "ended", endReason: "unreadable" }))).toContain("could not be read");
  });

  it("shows an idle Mono as waiting on CI, and each live watch as its project's job", () => {
    expect(waitingActivity([])).toBeUndefined();
    expect(waitingActivity([watch()])).toBe("Waiting on CI: #42");
    expect(waitingActivity([watch(), watch({ id: "w2", number: 43 })])).toBe("Waiting on CI for 2 pull requests");
    const rows = prWatchWorkers(
      [watch(), watch({ id: "w2", project: "vg-game" }), watch({ id: "w3", state: "ended", endReason: "merged" })],
      "hivra",
      1_200_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "pr:w1",
      projectId: "hivra",
      who: "Hivra lead",
      doing: "PR #42: Fix the save bug",
      state: "waiting_ci",
      minutes: 20,
      activeAgo: 10,
      prWatch: { id: "w1", ownerSession: "mono-hivra", line: "2 of 3 required checks done" },
    });
    expect(rows[0].steps.map((step) => step.text)).toEqual([
      "Checked GitHub: 2 of 3 required checks done",
      "Checkout: /w/hivra-pr-42",
      "Started watching ashneil12/hivra#42",
    ]);
  });
});

describe("telling the programme about a red CI", () => {
  it("names a failed-checks wake as a ci-red event, and nothing else", () => {
    expect(ciRedEvent(wake({ id: "pr-watch-w1-1", createdAt: 5_000 }))).toEqual({
      id: "pr-watch-w1-1",
      kind: "ci-red",
      text: "PR #42: checks failed",
      at: 5_000,
    });
    expect(
      ciRedEvent(wake({ id: "pr-watch-w1-2", title: "PR #42: checks failed, new comments" }))?.text,
    ).toBe("PR #42: checks failed, new comments");
    // a merge conflict is a failed wake too, but it is not a red CI
    expect(ciRedEvent(wake({ id: "a", title: "PR #42: merge conflict" }))).toBeNull();
    expect(ciRedEvent(wake({ id: "b", title: "PR #42: stopped watching, could not read it", kind: "unreadable" }))).toBeNull();
    expect(ciRedEvent(wake({ id: "c", title: "PR #42: checks passed", outcome: "completed" }))).toBeNull();
    expect(ciRedEvent(wake({ id: "d", title: "PR #42: new comments", outcome: "updated" }))).toBeNull();
    expect(ciRedEvent(wake({ id: "e", kind: "merged", title: "PR #42: merged", outcome: "completed" }))).toBeNull();
  });

  it("says the same words as the Rust side that writes the title", () => {
    const source = readFileSync("src-tauri/src/pr_watch/wake.rs", "utf8");
    expect(/const SUMMARY_FAILED: &str = "([^"]+)";/.exec(source)?.[1]).toBe(CHECKS_FAILED_SUMMARY);
  });

  it("reports a red CI once, when its wake first goes to the owner, not when it is queued again", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1" }), wake({ id: "pr-watch-w1-2", title: "PR #42: checks passed", outcome: "completed" })];
    const store = backend(wakes);
    const app = host([mono()]);
    const noticed = vi.fn();
    const tracker = new PrWatchTracker(store.api, { ...app.host, noticed });
    await tracker.deliver();
    expect(noticed.mock.calls.map(([w]) => w.id)).toEqual(["pr-watch-w1-1", "pr-watch-w1-2"]);

    // the app died after marking it queued but before the queue was saved: it is queued again, not noticed again
    noticed.mockClear();
    const lost = [wake({ id: "pr-watch-w1-3", delivery: "queued" })];
    await new PrWatchTracker(backend(lost).api, { ...host([mono()]).host, noticed }).deliver();
    expect(noticed).not.toHaveBeenCalled();
  });

  it("tells the notice who owns the wake and which watch it came from", async () => {
    const wakes = [wake({ id: "pr-watch-w1-1" })];
    const store = backend(wakes);
    store.api.list = vi.fn(async () => [watch({ id: "w1", repoRoot: "/code/hivra" })]);
    const app = host([mono()]);
    const noticed = vi.fn();
    const tracker = new PrWatchTracker(store.api, { ...app.host, noticed });
    await tracker.refresh();
    await tracker.deliver();
    const [, about] = noticed.mock.calls[0];
    expect(about.owner.id).toBe("mono-hivra");
    expect(about.watch?.repoRoot).toBe("/code/hivra");

    // a watch the list does not have yet is still noticed, with the owner alone
    const early = vi.fn();
    await new PrWatchTracker(backend([wake({ id: "pr-watch-w1-2" })]).api, { ...host([mono()]).host, noticed: early }).deliver();
    expect(early.mock.calls[0][1].watch).toBeUndefined();
  });

  it("reports a wake only after it is marked queued, so a write that failed cannot report it twice", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wakes = [wake({ id: "pr-watch-w1-1" })];
    const store = backend(wakes);
    const mark = store.api.setDelivery;
    let fails = 1;
    store.api.setDelivery = vi.fn(async (ids, delivery) => {
      if (fails-- > 0) throw new Error("database is locked");
      return mark(ids, delivery);
    });
    const app = host([mono()]);
    const noticed = vi.fn();
    const tracker = new PrWatchTracker(store.api, { ...app.host, noticed });

    await expect(tracker.deliver()).rejects.toThrow("database is locked");
    expect(noticed).not.toHaveBeenCalled();
    expect(wakes[0].delivery).toBe("pending");

    await tracker.deliver();
    expect(noticed).toHaveBeenCalledTimes(1);
    await tracker.deliver();
    expect(noticed).toHaveBeenCalledTimes(1);
  });

  it("does not report a wake whose owner is gone, and a failing notice does not stop delivery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noticed = vi.fn();
    const gone = [wake({ id: "pr-watch-w1-1", ownerSession: "gone" })];
    await new PrWatchTracker(backend(gone).api, { ...host([]).host, noticed }).deliver();
    expect(noticed).not.toHaveBeenCalled();

    const wakes = [wake({ id: "pr-watch-w1-1" })];
    const app = host([mono()]);
    const tracker = new PrWatchTracker(backend(wakes).api, {
      ...app.host,
      noticed: () => {
        throw new Error("storage blocked");
      },
    });
    expect(await tracker.deliver()).toEqual({ queued: 1, delivered: 0, dropped: 0 });
    expect(wakes[0].delivery).toBe("queued");
  });
});
