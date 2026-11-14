// Followed briefs: briefs to a busy chat (queued behind its work or steered into it) and a leadership Mono's brief to a
// project Lead's long-running chat (double delegation). The row is the sender's; its report is decided by watching the
// chat it went to, and goes back exactly once through the H2 report-back path.
import { describe, expect, it } from "vitest";
import { newSession, type Block, type QueuedMessage, type Session } from "../../sessions/model/session";
import {
  DelegationTracker,
  isOpenDelegation,
  type ChatBindInput,
  type Delegation,
  type DelegationsBackend,
  type DeliveryInput,
  type OwnedQuery,
  type RecordInput,
  type SettleInput,
} from "./delegations";
import {
  answeredReport,
  briefCancelled,
  briefSentAt,
  briefWaiting,
  currentLeadBrief,
  deliveryFor,
  FOLLOW_GRACE_MS,
  followStep,
  queueBriefForIdle,
  sendMode,
  withoutQueuedBrief,
} from "./followedBriefs";
import { completionReceipt } from "./monoSessionCompletion";
import { delegationTasksHost } from "./delegationTasks";

const RANK = { pending: 0, queued: 1, delivered: 2, acknowledged: 3 } as const;

/** delegations.rs's rules as far as followed briefs need them (its Rust tests cover the SQL): follow, parent, tree. */
class Store implements DelegationsBackend {
  rows = new Map<string, Delegation>();
  private seq = 0;
  now = 1_000;
  private copy = (row: Delegation) => structuredClone(row);
  async record(input: RecordInput) {
    const existing = [...this.rows.values()].find(
      (row) => row.ownerSession === input.ownerSession && row.requestId === input.requestId,
    );
    if (existing) return this.copy(existing);
    if (!input.follow)
      for (const older of this.rows.values())
        if (older.childSession === input.childSession && isOpenDelegation(older) && !older.follow) older.state = "cancelled";
    const above = [...this.rows.values()].filter((row) => row.childSession === input.ownerSession && isOpenDelegation(row));
    const parent = above.find((row) => row.id === input.parentId) ?? above.at(-1);
    const id = `t-${++this.seq}`;
    const row: Delegation = {
      id,
      ownerSession: input.ownerSession,
      ownerMono: input.ownerMono ?? null,
      batchId: input.batchId ?? null,
      parentId: parent?.id ?? null,
      rootId: parent?.rootId ?? id,
      childSession: input.childSession,
      requestId: input.requestId,
      generation: 1,
      project: input.project ?? null,
      title: input.title ?? null,
      brief: input.brief ?? null,
      goal: input.goal ?? null,
      askIds: input.askIds ?? [],
      state: "running",
      errorClass: null,
      error: null,
      retryable: null,
      resetsAt: null,
      result: null,
      pendingQuestion: null,
      delivery: "pending",
      deliveryMessage: null,
      createdAt: ++this.now,
      updatedAt: this.now,
      settledAt: null,
      log: [],
      version: 1,
      mirroredVersion: 0,
      mirrorError: null,
      follow: input.follow ?? null,
    };
    this.rows.set(id, row);
    return this.copy(row);
  }
  async settle(input: SettleInput) {
    const row = this.rows.get(input.id);
    if (!row || !isOpenDelegation(row) || row.generation !== input.generation)
      return { applied: false, row: row ? this.copy(row) : null };
    Object.assign(row, { state: input.state, result: input.result ?? null, error: input.error ?? null, settledAt: ++this.now });
    return { applied: true, row: this.copy(row) };
  }
  async reattach() {
    return null;
  }
  async setQuestion() {
    return { applied: false, row: null };
  }
  async setDelivery(input: DeliveryInput) {
    const changed: Delegation[] = [];
    for (const row of this.rows.values()) {
      if (!input.ids?.includes(row.id) && !(input.messageId && row.deliveryMessage === input.messageId)) continue;
      if (row.delivery === "disposed" || isOpenDelegation(row)) continue;
      const wanted = input.delivery;
      const ahead = wanted === "queued" ? row.delivery === "pending" : RANK[wanted as keyof typeof RANK] > RANK[row.delivery as keyof typeof RANK];
      if (!ahead && wanted !== "disposed") continue;
      row.delivery = wanted;
      if (wanted === "queued") row.deliveryMessage = input.queuedMessage ?? null;
      changed.push(this.copy(row));
    }
    return changed;
  }
  async cancel(ids: string[], reason?: string) {
    const changed: Delegation[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (isOpenDelegation(row)) Object.assign(row, { state: "cancelled", error: reason ?? null });
      row.delivery = "disposed";
      changed.push(this.copy(row));
    }
    return changed;
  }
  async refuse() {
    return { applied: false, row: null };
  }
  async listOpen() {
    return [...this.rows.values()].filter((row) => isOpenDelegation(row) || row.delivery === "pending" || row.delivery === "queued").map(this.copy);
  }
  async tree(id: string) {
    const root = this.rows.get(id)?.rootId;
    return [...this.rows.values()].filter((row) => row.rootId === root).map(this.copy);
  }
  async owned(query: OwnedQuery) {
    return [...this.rows.values()]
      .filter((row) => row.ownerSession === query.ownerSession && (query.ids?.includes(row.id) || query.requestIds?.includes(row.requestId)))
      .map(this.copy);
  }
  async reportsSeen() {
    return [];
  }
  async bindChat(_input: ChatBindInput) {
    return true;
  }
}

function chat(id: string, blocks: Block[] = [], extra: Partial<Session> = {}): Session {
  return { ...newSession("/p/monocode-hub"), id, title: id, blocks, ...extra };
}
const user = (text: string, appRequestId?: string): Block => ({
  id: crypto.randomUUID(),
  role: "user",
  text,
  ...(appRequestId ? { appRequestId } : {}),
});
const said = (text: string): Block => ({ id: crypto.randomUUID(), role: "assistant", text });

function row(over: Partial<Delegation> = {}): Delegation {
  return {
    id: "t-1",
    ownerSession: "cos-chat",
    ownerMono: "ada",
    batchId: null,
    parentId: null,
    rootId: "t-1",
    childSession: "lead-chat",
    requestId: "app-cos-chat-b1",
    generation: 1,
    project: "hub",
    title: "Ship the room",
    brief: "[MonoCode brief from Chief of Staff]\n\nShip the room",
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
    createdAt: 10_000,
    updatedAt: 10_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    follow: "queue",
    ...over,
  };
}

describe("how a brief goes into a chat", () => {
  it("starts on an idle chat, queues behind a busy one or one with messages waiting, steers only when asked and able", () => {
    expect(deliveryFor({ busy: false }, "auto", true)).toBe("started");
    expect(deliveryFor({ busy: true }, "auto", true)).toBe("queued");
    expect(deliveryFor({ busy: true }, "queue", true)).toBe("queued");
    expect(deliveryFor({ busy: true }, "steer", true)).toBe("steered");
    expect(deliveryFor({ busy: true }, "steer", false)).toBe("queued");
    const waiting: QueuedMessage = { id: "q", text: "earlier", attachments: [] };
    expect(deliveryFor({ busy: false, queuedMessages: [waiting] }, "steer", true)).toBe("queued");
    expect(sendMode(undefined)).toBe("auto");
    expect(() => sendMode("now")).toThrow('mode must be "auto", "queue" or "steer"');
  });
});

describe("followStep", () => {
  const queued: QueuedMessage = { id: "app-cos-chat-b1", appRequestId: "app-cos-chat-b1", text: "brief", attachments: [], waitForIdle: true };

  it("waits while queued; a brief taken out of the queue is cancelled after the grace period", () => {
    const r = row();
    expect(followStep(r, { chat: chat("lead-chat", [], { busy: true, queuedMessages: [queued] }), children: [], now: 99_000 })).toEqual({ kind: "wait", why: "queued" });
    const removed = chat("lead-chat", [], { busy: false });
    expect(followStep(r, { chat: removed, children: [], now: r.createdAt + FOLLOW_GRACE_MS - 1 }).kind).toBe("wait");
    expect(followStep(r, { chat: removed, children: [], now: r.createdAt + FOLLOW_GRACE_MS + 1 })).toEqual({
      kind: "cancel",
      reason: "It was taken out of lead-chat's queue before it started.",
    });
    expect(followStep(r, { chat: null, children: [], now: 0 })).toEqual({ kind: "cancel", reason: "The chat it was sent to is gone." });
  });

  it("once it went in: waits while the chat works, then reports the reply to it (or its error)", () => {
    const r = row();
    const blocks = [user("earlier work"), said("earlier reply"), user("brief", r.requestId), said("Done: the room ships.")];
    expect(followStep(r, { chat: chat("lead-chat", blocks, { busy: true }), children: [], now: 0 })).toEqual({ kind: "wait", why: "working" });
    const step = followStep(r, { chat: chat("lead-chat", blocks), children: [], now: 0 });
    expect(step).toMatchObject({ kind: "settle", result: { status: "completed", result: "Done: the room ships." } });
    const failed = followStep(r, {
      chat: chat("lead-chat", [user("brief", r.requestId), { id: "e", role: "system", text: "billing refused", notice: "error" }]),
      children: [],
      now: 0,
    });
    expect(failed).toMatchObject({ kind: "settle", result: { status: "failed", error: "billing refused" } });
  });

  it("a Lead's brief waits for every worker it started for it, then reports the Lead's latest reply", () => {
    const r = row({ follow: "lead" });
    const worker = row({ id: "t-2", parentId: "t-1", ownerSession: "lead-chat", childSession: "worker", requestId: "w1", follow: null, state: "completed", delivery: "queued", deliveryMessage: "mono-completion-w1-g1" });
    const blocks = [user("brief", r.requestId), said("Handed to a worker."), user("[MonoCode report] ...", "mono-completion-w1-g1"), said("Reviewed: shipped at abc123.")];
    expect(followStep(r, { chat: chat("lead-chat", blocks), children: [r, worker], now: 0 })).toEqual({ kind: "wait", why: "workers" });
    const step = followStep(r, { chat: chat("lead-chat", blocks), children: [r, { ...worker, delivery: "delivered" }], now: 0 });
    expect(step).toMatchObject({ kind: "settle", result: { status: "completed", result: "Reviewed: shipped at abc123." } });
    // Another brief's worker (a different parent) doesn't hold this one.
    const other = { ...worker, parentId: "t-9" };
    expect(followStep(r, { chat: chat("lead-chat", blocks), children: [r, other], now: 0 }).kind).toBe("settle");
  });

  it("two briefs in one Lead chat: each reports its own turn (or its workers' report turn), never the other's", () => {
    const one = row({ id: "t-a", requestId: "app-cos-a", follow: "lead" });
    const two = row({ id: "t-b", requestId: "app-cos-b", follow: "lead" });
    const worker = row({ id: "t-w", parentId: "t-b", ownerSession: "lead-chat", childSession: "w", requestId: "w2", follow: null, state: "completed", delivery: "delivered", deliveryMessage: "mono-completion-w2-g1" });
    const lead = chat("lead-chat", [
      user("brief one", "app-cos-a"),
      said("Did brief one myself: done."),
      user("brief two", "app-cos-b"),
      said("Handed brief two to a worker."),
      user("[MonoCode report] w2", "mono-completion-w2-g1"),
      said("Brief two: the worker shipped it."),
    ]);
    expect(followStep(one, { chat: lead, children: [one], now: 0 })).toMatchObject({ kind: "settle", result: { result: "Did brief one myself: done." } });
    expect(followStep(two, { chat: lead, children: [two, worker], now: 0 })).toMatchObject({ kind: "settle", result: { result: "Brief two: the worker shipped it." } });
  });

  it("a worker that says it cannot finish fails the brief at once, naming it; a block the Lead retried does not", () => {
    const r = row({ follow: "lead" });
    const blocks = [user("brief", r.requestId), said("Handed to two workers.")];
    const blocked = row({
      id: "t-ui",
      parentId: "t-1",
      ownerSession: "lead-chat",
      childSession: "ui-worker",
      requestId: "w-ui",
      follow: null,
      title: "UI",
      state: "running",
      stallKind: "blocked",
      stallReason: "the staging deploy key is not on this machine",
      stalledAt: 0,
    });
    const step = followStep(r, { chat: chat("lead-chat", blocks), children: [r, blocked], now: 60_000 });
    expect(step).toMatchObject({
      kind: "settle",
      result: { status: "failed", error: "UI cannot finish: the staging deploy key is not on this machine." },
    });
    // The Lead took the block on itself (a redo logged in its row): the brief waits on it again, not fails.
    const retried = { ...blocked, log: [{ at: 1, by: "owner:lead-chat", event: "lead_redo" }] };
    expect(followStep(r, { chat: chat("lead-chat", blocks), children: [r, retried], now: 60_000 })).toEqual({ kind: "wait", why: "workers" });
  });

  it("a Lead's done claim is checked against its workers: a failed one fails the brief, a finished one does not", () => {
    const r = row({ follow: "lead" });
    const blocks = [user("brief", r.requestId), said("All done: the room ships.")];
    const failed = row({
      id: "t-ui",
      parentId: "t-1",
      ownerSession: "lead-chat",
      childSession: "ui-worker",
      requestId: "w-ui",
      follow: null,
      title: "UI",
      state: "failed",
      error: "The build broke.",
      settledAt: 0,
      // Its failure has already reached the Lead: nothing is still owed to it.
      delivery: "delivered",
    });
    expect(followStep(r, { chat: chat("lead-chat", blocks), children: [r, failed], now: 60_000 })).toMatchObject({
      kind: "settle",
      result: { status: "failed", error: "Not done: UI — Failed: the build broke." },
    });
    // The same worker finishing is its work landing: the Lead's claim stands.
    const done = { ...failed, state: "completed" as const, error: null };
    expect(followStep(r, { chat: chat("lead-chat", blocks), children: [r, done], now: 60_000 })).toMatchObject({
      kind: "settle",
      result: { status: "completed", result: "All done: the room ships." },
    });
  });

  it("a brief queued behind a Mono's work has no bubble until it goes in (so its turn lands after the work)", () => {
    const queued = queueBriefForIdle(chat("lead-chat", [user("Ash: fix the doc")], { busy: true }), { text: "Ship it", attachments: [], requestId: "app-cos-b1" });
    expect(queued.blocks).toHaveLength(1);
    expect(queued.queuedMessages).toEqual([{ id: "app-cos-b1", appRequestId: "app-cos-b1", waitForIdle: true, text: "Ship it", attachments: [] }]);
    expect(queued.queueStatus).toBe("active");
    expect(briefWaiting({ requestId: "app-cos-b1" }, queued)?.id).toBe("app-cos-b1");
  });

  it("a Lead works for the brief most recently sent into its chat; taking a queued brief out drops its pending bubble", () => {
    const a = row({ id: "t-a", requestId: "app-cos-a", follow: "lead" });
    const b = row({ id: "t-b", requestId: "app-pm-b", follow: "lead" });
    const waiting = row({ id: "t-c", requestId: "app-pm-c", follow: "lead" });
    const lead = chat("lead-chat", [user("a", "app-cos-a"), said("on it"), user("b", "app-pm-b")]);
    expect(currentLeadBrief([a, b, waiting], lead)?.id).toBe("t-b");
    expect(currentLeadBrief([a, { ...b, state: "completed" }], lead)?.id).toBe("t-a");
    expect(briefSentAt(waiting, lead)).toBe(-1);
    const bubble = user("pending brief");
    const message: QueuedMessage = { id: "app-pm-c", appRequestId: "app-pm-c", blockId: bubble.id, text: "pending brief", attachments: [] };
    const out = withoutQueuedBrief(chat("lead-chat", [bubble], { queuedMessages: [message], queueStatus: "active" }), message);
    expect(out.queuedMessages).toBeUndefined();
    expect(out.blocks).toEqual([]);
  });
});

describe("double delegation through the rows: leadership -> Lead -> worker -> report back, once", () => {
  it("Chief of Staff briefs the busy MonoCode Hub lead, the Lead's worker reports, and the Lead's final reply goes back once", async () => {
    const store = new Store();
    const sessions = new Map<string, Session>();
    const reports: { owner: string; message: QueuedMessage }[] = [];
    const tracker = new DelegationTracker(store, {
      session: (id) => sessions.get(id),
      load: async (id) => sessions.get(id) ?? null,
      openOwner: async (id) => sessions.get(id) ?? null,
      isMono: (id) => id.endsWith("-chat"),
      queueReport: async (owner, message) => void reports.push({ owner, message }),
      quitting: () => false,
    });
    await tracker.boot(true);
    sessions.set("cos-chat", chat("cos-chat"));
    // The Lead is mid-turn on something else: the brief queues behind it.
    const brief = "[MonoCode brief from Chief of Staff]\n\nShip the room";
    const requestId = "app-cos-chat-b1";
    const lead = await tracker.launch({ ownerSession: "cos-chat", ownerMono: "ada", requestId, childSession: "lead-chat", project: "hub", title: "Ship the room", brief, follow: "lead" }).row;
    sessions.set("lead-chat", chat("lead-chat", [user("Ash: fix the doc"), said("fixing")], {
      busy: true,
      queuedMessages: [{ id: requestId, appRequestId: requestId, text: brief, attachments: [], waitForIdle: true }],
    }));
    const look = async (r: Delegation) => followStep(r, { chat: sessions.get("lead-chat")!, children: await store.tree(r.id), now: 5_000 });
    expect(await look(lead!)).toEqual({ kind: "wait", why: "queued" });

    // The doc fix ends; the brief goes in as the Lead's own turn, and the Lead hands it to a worker.
    sessions.set("lead-chat", chat("lead-chat", [user("Ash: fix the doc"), said("fixed"), user(brief, requestId), said("Handed to a worker.")], { busy: true }));
    const working = currentLeadBrief(tracker.known(), sessions.get("lead-chat")!);
    expect(working?.id).toBe(lead!.id);
    const worker = await tracker.launch({ ownerSession: "lead-chat", requestId: "w1", childSession: "app-lead-chat-w1", parentId: working!.id }).row;
    expect(worker).toMatchObject({ parentId: lead!.id, rootId: lead!.id });
    // The Lead's brief turn ends: its worker is still out, so nothing goes back yet.
    sessions.set("lead-chat", { ...sessions.get("lead-chat")!, busy: false });
    expect(await look(lead!)).toEqual({ kind: "wait", why: "workers" });

    // The worker finishes; its report reaches the Lead as a turn; the Lead reviews it.
    await store.settle({ id: worker!.id, generation: 1, state: "completed", result: "WORKER-DONE" });
    await store.setDelivery({ ids: [worker!.id], delivery: "queued", queuedMessage: "mono-completion-w1-g1" });
    expect(await look(lead!)).toEqual({ kind: "wait", why: "workers" });
    await store.setDelivery({ ids: [worker!.id], delivery: "delivered" });
    const lc = sessions.get("lead-chat")!;
    sessions.set("lead-chat", { ...lc, blocks: [...lc.blocks, user("[MonoCode report] WORKER-DONE", "mono-completion-w1-g1"), said("Reviewed the worker's report: shipped.")] });
    const step = await look(lead!);
    expect(step).toMatchObject({ kind: "settle", result: { result: "Reviewed the worker's report: shipped." } });
    if (step.kind !== "settle") throw new Error("expected settle");

    // One report to Chief of Staff, under its receipt; a second settle changes nothing.
    expect(await tracker.settleFollowed(lead!, step.result)).toBe(true);
    expect(await tracker.settleFollowed(lead!, step.result)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0].owner).toBe("cos-chat");
    expect(reports[0].message.id).toBe(completionReceipt(requestId, 1));
    expect(tracker.openFollowed()).toEqual([]);

    // Chief of Staff gets it as a turn and answers; then (and only then) the room can show both.
    const settled = (await store.owned({ ownerSession: "cos-chat", ids: [lead!.id] }))[0];
    const receipt = completionReceipt(requestId, 1);
    expect(answeredReport(settled, sessions.get("cos-chat")!, receipt)).toBeUndefined();
    await store.setDelivery({ ids: [lead!.id], delivery: "delivered" });
    const delivered = (await store.owned({ ownerSession: "cos-chat", ids: [lead!.id] }))[0];
    sessions.set("cos-chat", chat("cos-chat", [user("[MonoCode report] ...", receipt), said("Good: the room shipped. Ash, nothing needed.")]));
    expect(answeredReport(delivered, sessions.get("cos-chat")!, receipt)).toEqual({
      report: "Reviewed the worker's report: shipped.",
      answer: "Good: the room shipped. Ash, nothing needed.",
    });
    expect(answeredReport(delivered, { ...sessions.get("cos-chat")!, busy: true }, receipt)).toBeUndefined();
  });

  it("a queued brief to a busy worker leaves that worker's current task running and reports its own reply", async () => {
    const store = new Store();
    const earlier = await store.record({ ownerSession: "mono-exo", requestId: "r1", childSession: "worker" });
    const queued = await store.record({ ownerSession: "mono-exo", requestId: "r2", childSession: "worker", follow: "queue" });
    expect((await store.owned({ ownerSession: "mono-exo", ids: [earlier.id] }))[0].state).toBe("running");
    const worker = chat("worker", [user("first", "r1"), said("first done"), user("second", "r2"), said("second done")]);
    expect(followStep(queued, { chat: worker, children: [], now: 0 })).toMatchObject({ kind: "settle", result: { result: "second done" } });
  });
});

describe("task_cancel on a followed brief", () => {
  it("takes it out of the chat's queue and never stops that chat (a Lead keeps its own chat)", async () => {
    const store = new Store();
    const tracker = new DelegationTracker(store, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => true,
      queueReport: async () => undefined,
      quitting: () => false,
    });
    await tracker.boot(false);
    const lead = await tracker.launch({ ownerSession: "cos-chat", requestId: "app-cos-chat-b1", childSession: "lead-chat", follow: "lead" }).row;
    const stopped: string[] = [];
    const unqueued: string[][] = [];
    const host = delegationTasksHost({
      backend: store,
      tracker: () => tracker,
      session: (id) => chat(id, [], { busy: true }),
      stop: async (id) => void stopped.push(id),
      dropReport: () => undefined,
      unqueue: (child, request) => void unqueued.push([child, request]),
    });
    expect(await host.cancel("cos-chat", lead!, "Ash changed his mind.")).toEqual({ stopFailed: [] });
    expect(unqueued).toEqual([["lead-chat", "app-cos-chat-b1"]]);
    expect(stopped).toEqual([]);
    expect(store.rows.get(lead!.id)).toMatchObject({ state: "cancelled", error: "Ash changed his mind." });
  });
});

describe("briefCancelled", () => {
  it("is true only for the brief's own row, and only once that row is cancelled", () => {
    const rows = [
      { requestId: "app-cos-lead-1", state: "running" as const },
      { requestId: "app-cos-lead-2", state: "cancelled" as const },
      { requestId: "app-cos-lead-3", state: "completed" as const },
    ];
    expect(briefCancelled(rows, "app-cos-lead-2")).toBe(true);
    expect(briefCancelled(rows, "app-cos-lead-1")).toBe(false);
    expect(briefCancelled(rows, "app-cos-lead-3")).toBe(false);
    // A brief without a followed row (no report asked for) is never held back by one.
    expect(briefCancelled([], "app-cos-lead-4")).toBe(false);
  });
});

it("a followed leadership handoff reports the CLI's weekly limit as failed work, not completed work", () => {
  const r = row({ follow: "lead" });
  const result = followStep(r, {
    chat: chat("lead-chat", [user(r.brief!, r.requestId), said("You've hit your weekly limit · resets Nov 17 at 1am (Europe/London)")]),
    children: [], now: 99_000,
  });
  expect(result).toMatchObject({kind: "settle", result: {status: "failed", errorClass: "usage_limit"}});
});
