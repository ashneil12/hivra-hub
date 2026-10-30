// Delegations that survive restarts: the four cases T3 Code checks in
// apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts (MIT, pingdotgg/t3code @2532e640), re-told on
// MonoCode's pieces (child finished while the app was closed, owner Stop, duplicate read-ack, resumed turn), plus the
// restart Ash asked for: a Mono's two children, the app quit mid-run, exactly one report each.
import { describe, expect, it, vi } from "vitest";
import {
  CONTINUE_PROMPT,
  INTERRUPT_MESSAGE,
} from "../../sessions/model/inFlight";
import {
  newSession,
  type Block,
  type QueuedMessage,
  type Session,
} from "../../sessions/model/session";
import {
  bootStep,
  bootUntilLoaded,
  DelegationTracker,
  isOpenDelegation,
  storedResult,
  type ChatBindInput,
  type Delegation,
  type DelegationsBackend,
  type DeliveryInput,
  type OwnedQuery,
  type RecordInput,
  type SettleInput,
} from "./delegations";
import {
  dismissQueuedMonoSessionCompletion,
  enqueueMonoSessionCompletion,
  monoSessionCompletionResult,
  MonoSessionCompletionBatches,
} from "./monoSessionCompletion";
import { delegationTasksHost } from "./delegationTasks";

const RANK = { pending: 0, queued: 1, delivered: 2, acknowledged: 3 } as const;

/** The store's rules (src-tauri/src/delegations.rs), in memory. Its own Rust tests cover the real SQL. */
class MemoryStore implements DelegationsBackend {
  rows = new Map<string, Delegation>();
  /** Report ids in each owner's saved transcript. */
  transcripts = new Map<string, Set<string>>();
  binds: ChatBindInput[] = [];
  private seq = 0;
  private now = 1_000;

  private touch(row: Delegation, event: string) {
    row.version++;
    row.updatedAt = ++this.now;
    row.log = [...row.log, { at: row.updatedAt, event }].slice(-50);
  }

  private copy = (row: Delegation) => structuredClone(row);

  async record(input: RecordInput) {
    const existing = [...this.rows.values()].find(
      (row) =>
        row.ownerSession === input.ownerSession &&
        row.requestId === input.requestId,
    );
    if (existing) return this.copy(existing);
    for (const older of this.rows.values())
      if (older.childSession === input.childSession && isOpenDelegation(older)) {
        older.state = "cancelled";
        if (older.ownerSession === input.ownerSession) older.delivery = "disposed";
        this.touch(older, "superseded");
      }
    const id = `t-${++this.seq}`;
    const row: Delegation = {
      id,
      ownerSession: input.ownerSession,
      ownerMono: input.ownerMono ?? null,
      batchId: input.batchId ?? null,
      parentId: null,
      rootId: id,
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
      log: [{ event: "recorded" }],
      version: 1,
      mirroredVersion: 0,
      mirrorError: null,
    };
    this.rows.set(id, row);
    return this.copy(row);
  }

  async settle(input: SettleInput) {
    const row = this.rows.get(input.id);
    if (!row) return { applied: false, row: null };
    if (!isOpenDelegation(row) || row.generation !== input.generation)
      return { applied: false, row: this.copy(row) };
    Object.assign(row, {
      state: input.state,
      result: input.result ?? null,
      error: input.error ?? null,
      errorClass: input.errorClass ?? null,
      settledAt: this.now,
    });
    this.touch(row, "settled");
    return { applied: true, row: this.copy(row) };
  }

  async reattach(childSession: string, resume: boolean) {
    const row = [...this.rows.values()]
      .filter((r) => r.childSession === childSession && r.delivery !== "disposed")
      .at(-1);
    if (!row) return null;
    const reopen = resume && (row.state === "failed" || row.state === "cancelled");
    if (!isOpenDelegation(row) && !reopen) return null;
    row.generation++;
    if (reopen)
      Object.assign(row, {
        state: "running",
        result: null,
        error: null,
        delivery: "pending",
        deliveryMessage: null,
      });
    this.touch(row, "resumed");
    return this.copy(row);
  }

  async setQuestion() {
    return { applied: false, row: null };
  }

  async setDelivery(input: DeliveryInput) {
    const rows = [...this.rows.values()].filter(
      (row) =>
        input.ids?.includes(row.id) ||
        (input.messageId && row.deliveryMessage === input.messageId),
    );
    const changed: Delegation[] = [];
    for (const row of rows) {
      const wanted = input.delivery;
      if (row.delivery === "disposed") continue;
      let move = wanted === "disposed";
      if (!move && !isOpenDelegation(row)) {
        if (wanted === "queued" && row.delivery === "queued")
          move = !!input.queuedMessage && row.deliveryMessage !== input.queuedMessage;
        else
          move =
            wanted in RANK &&
            row.delivery in RANK &&
            RANK[wanted as keyof typeof RANK] > RANK[row.delivery as keyof typeof RANK];
      }
      if (!move) continue;
      row.delivery = wanted;
      if (wanted === "queued") row.deliveryMessage = input.queuedMessage ?? null;
      this.touch(row, `delivery:${wanted}`);
      changed.push(this.copy(row));
    }
    return changed;
  }

  async cancel(ids: string[], reason?: string) {
    const changed: Delegation[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      const open = isOpenDelegation(row);
      if (!open && row.delivery !== "pending" && row.delivery !== "queued") continue;
      if (open) Object.assign(row, { state: "cancelled", error: reason ?? null });
      row.delivery = "disposed";
      this.touch(row, "cancelled");
      changed.push(this.copy(row));
    }
    return changed;
  }

  async refuse(id: string) {
    const row = this.rows.get(id);
    if (!row || row.state !== "running") return { applied: false, row: row ?? null };
    Object.assign(row, { state: "cancelled", delivery: "disposed" });
    this.touch(row, "refused");
    return { applied: true, row: this.copy(row) };
  }

  async listOpen() {
    return [...this.rows.values()]
      .filter(
        (row) =>
          isOpenDelegation(row) ||
          row.delivery === "pending" ||
          row.delivery === "queued",
      )
      .map(this.copy);
  }

  async tree(id: string) {
    const root = this.rows.get(id)?.rootId;
    return [...this.rows.values()].filter((row) => row.rootId === root).map(this.copy);
  }

  async owned(query: OwnedQuery) {
    const mine = [...this.rows.values()].filter(
      (row) => row.ownerSession === query.ownerSession,
    );
    if (!query.ids?.length && !query.requestIds?.length)
      return mine
        .filter(
          (row) =>
            isOpenDelegation(row) ||
            row.delivery === "pending" ||
            row.delivery === "queued",
        )
        .reverse()
        .map(this.copy);
    return mine
      .filter(
        (row) =>
          query.ids?.includes(row.id) || query.requestIds?.includes(row.requestId),
      )
      .map(this.copy);
  }

  async reportsSeen(owner: string, ids: string[]) {
    const seen = this.transcripts.get(owner) ?? new Set();
    return ids.filter((id) => seen.has(id));
  }

  async bindChat(input: ChatBindInput) {
    this.binds.push(input);
    return true;
  }
}

const MONO = "mono-exo";
const PROJECT = "/code/vg-game";

/** One app run: its sessions, the Mono's queue, the tracker and the in-memory batches it keeps as a cache. */
class AppRun {
  sessions = new Map<string, Session>();
  quitting = false;
  tracker: DelegationTracker;
  batches: MonoSessionCompletionBatches;

  constructor(
    public store: MemoryStore,
    saved: Session[] = [],
  ) {
    for (const session of saved) this.sessions.set(session.id, structuredClone(session));
    if (!this.sessions.has(MONO))
      this.sessions.set(MONO, { ...newSession("claude", PROJECT), id: MONO });
    this.tracker = new DelegationTracker(store, {
      session: (id) => this.sessions.get(id),
      load: async (id) => this.sessions.get(id) ?? null,
      openOwner: async (id) => this.sessions.get(id) ?? null,
      isMono: (id) => id === MONO,
      queueReport: async (monoId, message) => this.enqueue(monoId, message),
      quitting: () => this.quitting,
    });
    this.batches = new MonoSessionCompletionBatches(
      async (monoId, message, _current, requestIds) => {
        await this.tracker.queued(monoId, requestIds, message.id);
        this.enqueue(monoId, message);
      },
    );
  }

  get mono(): Session {
    return this.sessions.get(MONO)!;
  }

  enqueue(monoId: string, message: QueuedMessage) {
    this.sessions.set(monoId, enqueueMonoSessionCompletion(this.sessions.get(monoId)!, message));
  }

  /** The Mono's turn 1 starts a child, as the host's start path does: record, then watch. */
  async start(requestId: string, prompt: string) {
    const launch = this.tracker.launch({
      ownerSession: MONO,
      ownerMono: "vg-game-lead",
      batchId: "turn-1",
      requestId,
      childSession: requestId,
      project: PROJECT,
      title: prompt,
      brief: prompt,
    });
    const row = await launch.row;
    const watch = this.batches.watch({ monoId: MONO, turn: 1 }, requestId, requestId, {
      awaitAcceptance: true,
      generation: row?.generation,
    });
    watch.accept();
    this.sessions.set(requestId, {
      ...newSession("claude", PROJECT),
      id: requestId,
      title: prompt,
      busy: true,
      providerSessionId: `claude-${requestId}`,
      blocks: [{ id: `${requestId}-u`, role: "user", text: prompt, appRequestId: requestId }],
    });
    return {
      row,
      /** The child's turn ends with this reply. */
      finish: (reply: string) => {
        const child = this.sessions.get(requestId)!;
        this.sessions.set(requestId, {
          ...child,
          busy: false,
          blocks: [...child.blocks, { id: `${requestId}-a`, role: "assistant", text: reply }],
        });
        const result = monoSessionCompletionResult({
          requestId,
          sessionId: requestId,
          project: PROJECT,
          prompt,
          outcome: { status: "completed", text: reply },
          session: this.sessions.get(requestId),
        });
        launch.settle(result);
        watch(result);
      },
    };
  }

  /** The Mono's launching turn ended. */
  endMonoTurn() {
    this.batches.closeInactive(() => false);
  }

  /** The queue sends its head to the Mono as a turn: it is in the transcript now. */
  deliverHead() {
    const head = this.mono.queuedMessages?.[0];
    if (!head) return undefined;
    this.sessions.set(MONO, {
      ...this.mono,
      queuedMessages: this.mono.queuedMessages!.slice(1),
      blocks: [...this.mono.blocks, { id: crypto.randomUUID(), role: "user", text: head.text, appRequestId: head.id, internal: true }],
    });
    const seen = this.store.transcripts.get(MONO) ?? new Set<string>();
    seen.add(head.id);
    this.store.transcripts.set(MONO, seen);
    this.tracker.delivered(head.id);
    return head;
  }

  /** A real quit: every running turn is marked interrupted, and that state is what the next run loads. */
  quit(): Session[] {
    this.quitting = true;
    return [...this.sessions.values()].map((session) =>
      session.busy
        ? {
            ...session,
            busy: false,
            blocks: [...session.blocks, { id: crypto.randomUUID(), role: "system", text: INTERRUPT_MESSAGE, notice: "interrupt" } as Block],
          }
        : session,
    );
  }

  /** A turn the app submits on its own (auto-continue / a resume), watched the way submitSession watches it. */
  resume(childId: string, reply: string, text = CONTINUE_PROMPT) {
    const monitor = this.tracker.resumeMonitor(childId, text, false);
    const child = this.sessions.get(childId)!;
    this.sessions.set(childId, {
      ...child,
      busy: true,
      blocks: [...child.blocks, { id: crypto.randomUUID(), role: "user", text }],
    });
    monitor?.started();
    return () => {
      const running = this.sessions.get(childId)!;
      this.sessions.set(childId, {
        ...running,
        busy: false,
        blocks: [...running.blocks, { id: crypto.randomUUID(), role: "assistant", text: reply }],
      });
      monitor?.settled({ status: "completed", text: reply });
    };
  }

  async settledDown() {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Every report the Mono has received or still has queued, for one child. */
  reportsFor(childId: string): string[] {
    const texts = [
      ...this.mono.blocks.filter((block) => block.appRequestId?.startsWith("mono-completion-")).map((block) => block.text),
      ...(this.mono.queuedMessages ?? []).map((message) => message.text),
    ];
    return texts.filter((text) => text.includes(`"sessionId":"${childId}"`));
  }
}

const row = (store: MemoryStore, child: string) =>
  [...store.rows.values()].find((entry) => entry.childSession === child)!;

describe("delegations that survive restarts", () => {
  it("records before the child starts, and the live report moves the row to queued then delivered", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-a", "Fix the save bug");
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "running", delivery: "pending", ownerMono: "vg-game-lead" });
    child.finish("Fixed: the save test passes.");
    app.endMonoTurn();
    await app.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({
      state: "completed",
      delivery: "queued",
      deliveryMessage: "mono-completion-app-mono-exo-a-g1",
      result: "Fixed: the save test passes.",
    });
    const head = app.deliverHead()!;
    expect(head.text.startsWith("[MonoCode report] MonoCode completion notification")).toBe(true);
    await app.settledDown();
    expect(row(store, "app-mono-exo-a").delivery).toBe("delivered");
    // The next launch of the app has nothing to do.
    const next = new AppRun(store, app.quit());
    expect(await next.tracker.boot(true)).toMatchObject({ queue: 0, settle: 0, wait: 0 });
    expect(next.reportsFor("app-mono-exo-a")).toHaveLength(1);
  });

  // T3: "child finished while the app was closed" (a terminal child whose wake never went out is offered once).
  it("queues the report of a child that finished while the app was closed, once", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const fast = await app.start("app-mono-exo-a", "Say OK");
    await app.start("app-mono-exo-b", "Run the slow suite");
    fast.finish("OK");
    await app.settledDown();
    // The batch still waits for b and for the Mono's turn: only the stored row knows a's report is owed.
    expect(app.mono.queuedMessages ?? []).toHaveLength(0);
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "completed", delivery: "pending" });

    const saved = app.quit();
    const relaunch = new AppRun(store, saved);
    const summary = await relaunch.tracker.boot(true);
    expect(summary).toMatchObject({ queue: 1, wait: 1 });
    expect(relaunch.mono.queuedMessages?.map((message) => message.id)).toEqual(["mono-completion-app-mono-exo-a-g1"]);
    expect(relaunch.reportsFor("app-mono-exo-a")[0]).toContain('"result":"OK"');

    // Booting again (another restart before it was delivered) finds it waiting and adds nothing.
    const again = new AppRun(store, [...relaunch.sessions.values()]);
    expect(await again.tracker.boot(true)).toMatchObject({ queue: 0, queued: 1 });
    expect(again.reportsFor("app-mono-exo-a")).toHaveLength(1);
  });

  it("settles a child whose turn ended while the app was closing, from its transcript", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Say OK");
    const saved = app.quit().map((session) =>
      session.id === "app-mono-exo-a"
        ? {
            ...session,
            busy: false,
            // It answered before the quit; its settle never reached the store.
            blocks: [...session.blocks.filter((block) => block.notice !== "interrupt"), { id: "a", role: "assistant", text: "OK, done." } as Block],
          }
        : session,
    );
    const relaunch = new AppRun(store, saved);
    expect(await relaunch.tracker.boot(true)).toMatchObject({ settle: 1 });
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "completed", result: "OK, done.", delivery: "queued" });
    expect(relaunch.reportsFor("app-mono-exo-a")).toHaveLength(1);
  });

  it("reports a child that is gone as cancelled, and drops rows whose owner is gone", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Fix it");
    const saved = app.quit().filter((session) => session.id !== "app-mono-exo-a");
    const relaunch = new AppRun(store, saved);
    await relaunch.tracker.boot(true);
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "cancelled", error: "The session it was working in is gone." });
    expect(relaunch.reportsFor("app-mono-exo-a")[0]).toContain('"status":"cancelled"');

    const orphanStore = new MemoryStore();
    const orphan = new AppRun(orphanStore);
    await orphan.start("app-mono-exo-b", "Fix it");
    const withoutMono = new AppRun(orphanStore, orphan.quit());
    withoutMono.tracker = new DelegationTracker(orphanStore, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: () => false,
      queueReport: vi.fn(),
      quitting: () => false,
    });
    expect(await withoutMono.tracker.boot(true)).toMatchObject({ drop: 1 });
    expect(row(orphanStore, "app-mono-exo-b")).toMatchObject({ state: "cancelled", delivery: "disposed" });
  });

  // T3: owner Stop ("delivers a stopped follow-up ... disposed", thread.stop on the parent).
  it("drops the report for good when the owner stops its child", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-a", "Fix it");
    app.tracker.stopOwned(MONO, "app-mono-exo-a");
    app.batches.dismissSession(MONO, "app-mono-exo-a");
    await app.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "cancelled", delivery: "disposed" });
    // Its cancelled turn still ends, late: nothing is owed and nothing is sent.
    child.finish("stopped");
    app.endMonoTurn();
    await app.settledDown();
    expect(app.reportsFor("app-mono-exo-a")).toHaveLength(0);
    const relaunch = new AppRun(store, app.quit());
    await relaunch.tracker.boot(true);
    const resumed = relaunch.resume("app-mono-exo-a", "carried on");
    resumed();
    await relaunch.settledDown();
    expect(relaunch.reportsFor("app-mono-exo-a")).toHaveLength(0);
    expect(row(store, "app-mono-exo-a").generation).toBe(1);
  });

  // T3: "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops".
  it("treats a duplicate read-ack, and an ack after a dispose, as no-ops", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-a", "Fix it");
    child.finish("Fixed");
    app.endMonoTurn();
    await app.settledDown();
    app.deliverHead();
    await app.settledDown();
    const id = row(store, "app-mono-exo-a").id;
    const first = await store.setDelivery({ ids: [id], delivery: "acknowledged" });
    expect(first.map((entry) => entry.delivery)).toEqual(["acknowledged"]);
    const version = row(store, "app-mono-exo-a").version;
    expect(await store.setDelivery({ ids: [id], delivery: "acknowledged" })).toEqual([]);
    app.tracker.delivered("mono-completion-app-mono-exo-a-g1");
    await app.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ delivery: "acknowledged", version });
    expect((await store.setDelivery({ ids: [id], delivery: "disposed" })).map((entry) => entry.delivery)).toEqual(["disposed"]);
    expect(await store.setDelivery({ ids: [id], delivery: "disposed" })).toEqual([]);
    expect(await store.setDelivery({ ids: [id], delivery: "acknowledged" })).toEqual([]);
    expect(row(store, "app-mono-exo-a").delivery).toBe("disposed");
    const relaunch = new AppRun(store, app.quit());
    expect(await relaunch.tracker.boot(true)).toMatchObject({ queue: 0 });
    expect(relaunch.reportsFor("app-mono-exo-a")).toHaveLength(1);
  });

  // T3: "holds a restart-cancelled child for its continuation's result".
  it("holds a child cut off by the quit for its resumed turn, which re-attaches with a new generation", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Run the slow suite");
    const relaunch = new AppRun(store, app.quit());
    expect(await relaunch.tracker.boot(true)).toMatchObject({ wait: 1 });
    expect(relaunch.reportsFor("app-mono-exo-a")).toHaveLength(0);
    expect(bootStep(row(store, "app-mono-exo-a"), {
      owner: relaunch.mono,
      child: relaunch.sessions.get("app-mono-exo-a")!,
      seen: new Set(),
    })).toEqual({ kind: "wait" });

    const finish = relaunch.resume("app-mono-exo-a", "Finished after the restart.");
    await relaunch.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "running", generation: 2 });
    finish();
    await relaunch.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "completed", result: "Finished after the restart." });
    expect(relaunch.mono.queuedMessages?.map((message) => message.id)).toEqual(["mono-completion-app-mono-exo-a-g2"]);
    // The cut turn's own settle, had it ever arrived, belongs to generation 1 and changes nothing.
    expect((await store.settle({ id: row(store, "app-mono-exo-a").id, generation: 1, state: "cancelled" })).applied).toBe(false);
  });

  it("re-attaches a plain message in a cut-off child (a dev copy never continues it on its own)", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Run the slow suite");
    const relaunch = new AppRun(store, app.quit());
    await relaunch.tracker.boot(true);
    relaunch.resume("app-mono-exo-a", "Done now.", "please carry on")();
    await relaunch.settledDown();
    expect(relaunch.reportsFor("app-mono-exo-a")).toHaveLength(1);
    expect(row(store, "app-mono-exo-a").generation).toBe(2);
    // A later message in a child whose report went out is the user's own: no new report.
    expect(relaunch.tracker.resumeMonitor("app-mono-exo-a", "one more thing", false)).toBeUndefined();
  });

  it("reopens a usage-limit failure only for a resume, and reports it again under the next generation", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const launch = app.tracker.launch({ ownerSession: MONO, requestId: "app-mono-exo-a", childSession: "app-mono-exo-a", brief: "Fix it" });
    const recorded = (await launch.row)!;
    launch.settle({
      ...monoSessionCompletionResult({
        requestId: "app-mono-exo-a",
        sessionId: "app-mono-exo-a",
        project: PROJECT,
        prompt: "Fix it",
        outcome: { status: "failed", text: "", errorClass: "usage_limit", retryable: true },
      }),
    });
    await app.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ state: "failed", errorClass: "usage_limit", error: "failed: usage limit reached" });
    app.sessions.set("app-mono-exo-a", { ...newSession("claude", PROJECT), id: "app-mono-exo-a" });
    app.resume("app-mono-exo-a", "Done after the reset.")();
    await app.settledDown();
    expect(row(store, "app-mono-exo-a")).toMatchObject({ id: recorded.id, state: "completed", generation: 2 });
    expect(app.mono.queuedMessages?.map((message) => message.id)).toEqual(["mono-completion-app-mono-exo-a-g2"]);
  });

  // r84 (s14 blind 3): Ash answered a held worker in its chat; its checked report settled failed "without a self-review".
  it("reads a resumed job's self-review, so Ash's answered job settles done", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const launch = app.tracker.launch({ ownerSession: MONO, requestId: "app-mono-exo-a", childSession: "app-mono-exo-a", brief: "Delete tallies", reviewRequired: true });
    await launch.row;
    await app.settledDown();
    // The store keeps the flag (delegations.rs review_required); the memory store here doesn't, so it is set as stored.
    row(store, "app-mono-exo-a").reviewRequired = true;
    const settles: { state: string; selfReview?: string }[] = [];
    const settle = store.settle.bind(store);
    store.settle = (input) => {
      settles.push(input);
      return settle(input);
    };
    app.sessions.set("app-mono-exo-a", { ...newSession("claude", PROJECT), id: "app-mono-exo-a" });
    app.resume("app-mono-exo-a", "Kept 30 days.\n\n## Self-review\nChecked: delete then undo.\nHow: npm test.\nUnsure: nothing", "keep them 30 days")();
    await app.settledDown();
    expect(settles.at(-1)?.state).toBe("completed");
    expect(settles.at(-1)?.selfReview).toContain("delete then undo");
  });

  it("does not settle a turn the quit cut short: its resumed turn reports instead", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-a", "Fix it");
    app.quitting = true;
    child.finish("killed by the quit");
    await app.settledDown();
    expect(row(store, "app-mono-exo-a").state).toBe("running");
  });

  // Ash's check (19 Oct): a Mono starts two sessions, the app quits mid-run, and exactly one report arrives per child.
  it("gives a Mono exactly one report per child across a quit, a relaunch and another relaunch", async () => {
    const store = new MemoryStore();
    const first = new AppRun(store);
    const fast = await first.start("app-mono-exo-a", "Say OK");
    await first.start("app-mono-exo-b", "Sleep, then say DONE");
    fast.finish("OK");
    await first.settledDown();

    const second = new AppRun(store, first.quit());
    await second.tracker.boot(true);
    second.deliverHead();
    second.resume("app-mono-exo-b", "DONE")();
    await second.settledDown();
    second.deliverHead();
    await second.settledDown();

    const third = new AppRun(store, second.quit());
    expect(await third.tracker.boot(true)).toMatchObject({ queue: 0, settle: 0, wait: 0 });
    expect(third.reportsFor("app-mono-exo-a")).toHaveLength(1);
    expect(third.reportsFor("app-mono-exo-b")).toHaveLength(1);
    expect(third.mono.blocks.map((block) => block.appRequestId)).toEqual([
      "mono-completion-app-mono-exo-a-g1",
      "mono-completion-app-mono-exo-b-g2",
    ]);
    expect([...store.rows.values()].map((entry) => entry.delivery)).toEqual(["delivered", "delivered"]);
  });

  it("finds a report already in the owner's saved transcript and only marks it delivered", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-a", "Say OK");
    child.finish("OK");
    app.endMonoTurn();
    await app.settledDown();
    // The report turn reached the transcript, but the app died before the row heard.
    store.transcripts.set(MONO, new Set(["mono-completion-app-mono-exo-a-g1"]));
    const saved = app.quit().map((session) => (session.id === MONO ? { ...session, queuedMessages: [] } : session));
    const relaunch = new AppRun(store, saved);
    expect(await relaunch.tracker.boot(true)).toMatchObject({ delivered: 1, queue: 0 });
    expect(row(store, "app-mono-exo-a").delivery).toBe("delivered");
    expect(relaunch.mono.queuedMessages ?? []).toHaveLength(0);
  });

  it("a window that does not recover only learns the open rows", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const fast = await app.start("app-mono-exo-a", "Say OK");
    fast.finish("OK");
    await app.settledDown();
    const other = new AppRun(store, app.quit());
    expect(await other.tracker.boot(false)).toMatchObject({ queue: 0 });
    expect(other.mono.queuedMessages ?? []).toHaveLength(0);
  });
});

describe("the delegate tool's tasks on the rows (H3)", () => {
  function tasksFor(app: AppRun) {
    const stopped: string[] = [];
    const answered: unknown[] = [];
    const tasks = delegationTasksHost({
      backend: app.store,
      tracker: () => app.tracker,
      session: (id) => app.sessions.get(id),
      stop: async (id) => {
        stopped.push(id);
        const child = app.sessions.get(id)!;
        app.sessions.set(id, { ...child, busy: false });
      },
      dropReport: (owner, child) => {
        app.batches.dismissSession(owner, child);
        app.sessions.set(owner, dismissQueuedMonoSessionCompletion(app.sessions.get(owner)!, child));
      },
      respond: (child, requestId, reply) => answered.push([child.id, requestId, reply]),
      nextChange: async () => undefined,
    });
    return { tasks, stopped, answered };
  }

  it("a result read inside the owner's turn is received: acknowledged, and no report turn follows, even after a restart", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const child = await app.start("app-mono-exo-w", "Fix the save bug");
    child.finish("Fixed: saves survive a restart.");
    await app.settledDown();
    const { tasks } = tasksFor(app);
    const [finished] = await tasks.owned(MONO, { requestIds: ["app-mono-exo-w"] });
    expect(finished).toMatchObject({ state: "completed", delivery: "pending" });
    await tasks.acknowledge(MONO, [finished]);
    app.endMonoTurn();
    await app.settledDown();
    expect(row(store, "app-mono-exo-w").delivery).toBe("acknowledged");
    expect(app.reportsFor("app-mono-exo-w")).toEqual([]);
    expect(await tasks.owned(MONO, {})).toEqual([]);
    const next = new AppRun(store, app.quit());
    expect(await next.tracker.boot(true)).toMatchObject({ queue: 0, settle: 0 });
    expect(next.mono.queuedMessages ?? []).toHaveLength(0);
  });

  it("task_cancel cancels with its reason, stops the running worker and drops the report it owed", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-c", "Refactor the HUD");
    const { tasks, stopped } = tasksFor(app);
    const [open] = await tasks.owned(MONO, { requestIds: ["app-mono-exo-c"] });
    expect(await tasks.cancel(MONO, open, "Ash changed his mind")).toEqual({ stopFailed: [] });
    expect(stopped).toEqual(["app-mono-exo-c"]);
    expect(row(store, "app-mono-exo-c")).toMatchObject({
      state: "cancelled",
      delivery: "disposed",
      error: "Ash changed his mind",
    });
    app.endMonoTurn();
    await app.settledDown();
    expect(app.reportsFor("app-mono-exo-c")).toEqual([]);
  });

  it("a chat only ever reads its own rows", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-o", "Mine");
    await store.record({ ownerSession: "mono-hivra", requestId: "app-mono-hivra-x", childSession: "app-mono-hivra-x" });
    const { tasks } = tasksFor(app);
    const theirs = [...store.rows.values()].find((entry) => entry.ownerSession === "mono-hivra")!;
    expect(await tasks.owned(MONO, { ids: [theirs.id] })).toEqual([]);
    expect((await tasks.owned(MONO, {})).map((entry) => entry.childSession)).toEqual(["app-mono-exo-o"]);
  });

  it("an answer goes only to the worker's open question, and the row logs who answered", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-q", "Pick a save slot");
    const { tasks, answered } = tasksFor(app);
    const [open] = await tasks.owned(MONO, { requestIds: ["app-mono-exo-q"] });
    const setQuestion = vi.spyOn(store, "setQuestion");
    app.sessions.set("app-mono-exo-q", {
      ...app.sessions.get("app-mono-exo-q")!,
      pendingQuestion: { requestId: 7, questions: [] },
    });
    await expect(tasks.answer!(MONO, open, 8, { kind: "skipped" })).rejects.toThrow("no longer open");
    await tasks.answer!(MONO, open, 7, { kind: "answered", answers: { slot: ["two"] } });
    expect(answered).toEqual([["app-mono-exo-q", 7, { kind: "answered", answers: { slot: ["two"] } }]]);
    // Who answered, and what (H4).
    expect(setQuestion).toHaveBeenCalledWith(open.id, null, "owner:mono-exo", {
      requestId: 7,
      answers: { slot: ["two"] },
    });
  });

  it("a report rebuilt from a row names where the work ran, not the hub project id the row keeps for Ash OS", async () => {
    const store = new MemoryStore();
    const recorded = await store.record({
      ownerSession: MONO,
      requestId: "app-mono-exo-p",
      childSession: "app-mono-exo-p",
      project: "vg-game",
    });
    const finished = { ...recorded, state: "completed" as const, result: "Done" };
    const child = { ...newSession("claude", PROJECT), id: "app-mono-exo-p" };
    expect(storedResult(finished, child).project).toBe(PROJECT);
    expect(storedResult(finished).project).toBe("vg-game");
  });
});

describe("a boot whose open rows can't be loaded", () => {
  it("doesn't count as loaded, so a child's next turn still re-attaches to its open row; a later boot loads them", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Fix the save bug");
    const relaunch = new AppRun(store, app.quit());
    const listOpen = store.listOpen.bind(store);
    store.listOpen = async () => {
      throw new Error("database is locked");
    };
    await expect(relaunch.tracker.boot(true)).rejects.toThrow("database is locked");
    expect(relaunch.tracker.isLoaded()).toBe(false);
    // Ash's own message to the child (not a resume): with the open rows unknown, the store decides, so it re-attaches.
    expect(relaunch.tracker.resumeMonitor("app-mono-exo-a", "also check the autosave", false)).toBeDefined();
    store.listOpen = listOpen;
    await relaunch.tracker.boot(true);
    expect(relaunch.tracker.isLoaded()).toBe(true);
    expect(relaunch.tracker.openRowFor("app-mono-exo-a")?.childSession).toBe("app-mono-exo-a");
  });

  it("is tried again, further apart each time, until it loads (and recovery goes with the attempt that claims it)", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    await app.start("app-mono-exo-a", "Fix the save bug");
    const relaunch = new AppRun(store, app.quit());
    const listOpen = store.listOpen.bind(store);
    let failures = 2;
    store.listOpen = async () => {
      if (failures-- > 0) throw new Error("database is locked");
      return listOpen();
    };
    const waits: number[] = [];
    const attempts: boolean[] = [];
    const boot = vi.spyOn(relaunch.tracker, "boot");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await bootUntilLoaded(relaunch.tracker, {
      live: () => true,
      recover: () => true,
      attempted: ({ loaded }) => void attempts.push(loaded),
      wait: async (ms) => void waits.push(ms),
    });
    error.mockRestore();
    expect(loaded).toBe(true);
    expect(attempts).toEqual([false, false, true]);
    expect(waits).toEqual([2_000, 5_000]);
    expect(boot.mock.calls).toEqual([[true], [true], [true]]);
    expect(relaunch.tracker.isLoaded()).toBe(true);
  });

  it("stops trying once its window has gone", async () => {
    const store = new MemoryStore();
    const relaunch = new AppRun(store);
    store.listOpen = async () => {
      throw new Error("database is locked");
    };
    let live = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await bootUntilLoaded(relaunch.tracker, {
      live: () => live,
      recover: () => false,
      wait: async () => {
        live = false;
      },
    });
    error.mockRestore();
    expect(loaded).toBe(false);
    expect(relaunch.tracker.isLoaded()).toBe(false);
  });
});

describe("the rows a window keeps", () => {
  it("lets go of a row once its work is settled and its report reached the owner (or was thrown away)", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const done = await app.start("app-mono-exo-a", "Fix the save bug");
    done.finish("Fixed.");
    app.endMonoTurn();
    await app.settledDown();
    // Finished, its report queued: still owed, still kept.
    expect(app.tracker.row(done.row!.id)).toMatchObject({ delivery: "queued" });
    app.deliverHead();
    await app.settledDown();
    expect(store.rows.get(done.row!.id)).toMatchObject({ delivery: "delivered" });
    expect(app.tracker.row(done.row!.id)).toBeUndefined();
    const running = await app.start("app-mono-exo-b", "Fix the audio");
    expect(app.tracker.known().map((row) => row.childSession)).toEqual(["app-mono-exo-b"]);
    expect(app.tracker.openRowFor("app-mono-exo-b")?.id).toBe(running.row!.id);
  });

  it("keeps a Lead's delivered report until its room post is done", async () => {
    const store = new MemoryStore();
    const app = new AppRun(store);
    const launch = app.tracker.launch({ ownerSession: MONO, requestId: "app-cos-b1", childSession: "lead-chat", follow: "lead" });
    const lead = (await launch.row)!;
    // This store doesn't keep `follow` (followedBriefs.test.ts covers it): set it as delegations.rs would.
    store.rows.get(lead.id)!.follow = "lead";
    await store.settle({ id: lead.id, generation: 1, state: "completed", result: "Shipped." });
    await store.setDelivery({ ids: [lead.id], delivery: "queued", queuedMessage: "mono-completion-app-cos-b1-g1" });
    await app.tracker.refresh([lead.id], MONO);
    app.tracker.delivered("mono-completion-app-cos-b1-g1");
    await app.settledDown();
    expect(app.tracker.row(lead.id)).toMatchObject({ delivery: "delivered" });
    app.tracker.forget(lead.id);
    expect(app.tracker.row(lead.id)).toBeUndefined();
  });
});
