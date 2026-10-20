// The PR watch's webview side (prWatches.ts, prWatchJobs.ts): a stored wake reaches its owner's chat exactly once,
// across restarts, as an app notification; the board's words for a watch. The store is a stand-in with pr_watch.rs's
// forward-only delivery rule.
import { describe, expect, it, vi } from "vitest";
import { newSession, type QueuedMessage, type Session } from "../../sessions/model/session";
import {
  PrWatchTracker,
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
