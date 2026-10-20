// An in-memory DelegationsBackend with the store's rules (src-tauri/src/delegations.rs), for the delegation tree's
// tests (H4): rows link to their parent the way `record` does (the owner is itself the child of an open row), questions
// move rows to `question` and back with a log line, and cancel throws away what is still owed. The Rust tests cover
// the real SQL; this is only ever imported by tests.
import {
  isOpenDelegation,
  isOwed,
  type ChatBindInput,
  type Delegation,
  type DelegationsBackend,
  type DeliveryInput,
  type OwnedQuery,
  type RecordInput,
  type SettleInput,
  type StallInput,
} from "./delegations";

const RANK = { pending: 0, queued: 1, delivered: 2, acknowledged: 3 } as const;

export class MemoryDelegations implements DelegationsBackend {
  rows = new Map<string, Delegation>();
  calls: string[] = [];
  private seq = 0;
  now = 1_000;

  private copy = (row: Delegation) => structuredClone(row);

  private note(
    row: Delegation,
    by: string,
    event: string,
    extra: Record<string, unknown> = {},
  ) {
    row.version++;
    row.updatedAt = ++this.now;
    row.log = [...row.log, { at: row.updatedAt, by, event, ...extra }].slice(
      -50,
    );
  }

  /** A row by id, as stored (tests read it directly). */
  get(id: string): Delegation {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  async record(input: RecordInput) {
    this.calls.push(`record:${input.childSession}`);
    const existing = [...this.rows.values()].find(
      (row) =>
        row.ownerSession === input.ownerSession &&
        row.requestId === input.requestId,
    );
    if (existing) return this.copy(existing);
    const parents = [...this.rows.values()].filter(
      (row) => row.childSession === input.ownerSession && isOpenDelegation(row),
    );
    const parent = parents.find((row) => row.id === input.parentId) ?? parents[parents.length - 1];
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
      log: [{ by: input.by ?? "app", event: "recorded" }],
      version: 1,
      mirroredVersion: 0,
      mirrorError: null,
      ...(input.follow ? { follow: input.follow } : {}),
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
      pendingQuestion: null,
      settledAt: this.now,
      ...UNSTALLED,
    });
    this.note(row, input.by ?? "app", "settled", { state: input.state });
    return { applied: true, row: this.copy(row) };
  }

  async reattach() {
    return null;
  }

  async setQuestion(
    id: string,
    question: string | null,
    by?: string,
    detail?: Record<string, unknown>,
  ) {
    this.calls.push(
      `question:${id}:${question === null ? "answered" : "asked"}:${by ?? "app"}`,
    );
    const row = this.rows.get(id);
    if (!row) return { applied: false, row: null };
    const next = question === null ? "running" : "question";
    if (
      !isOpenDelegation(row) ||
      (row.state === next && row.pendingQuestion === question)
    )
      return { applied: false, row: this.copy(row) };
    row.state = next;
    row.pendingQuestion = question;
    Object.assign(row, UNSTALLED);
    this.note(
      row,
      by ?? "app",
      question === null ? "answered" : "asked",
      detail ?? {},
    );
    return { applied: true, row: this.copy(row) };
  }

  async setDelivery(input: DeliveryInput) {
    const changed: Delegation[] = [];
    for (const row of this.rows.values()) {
      if (
        !input.ids?.includes(row.id) &&
        !(input.messageId && row.deliveryMessage === input.messageId)
      )
        continue;
      if (row.delivery === "disposed") continue;
      const wanted = input.delivery;
      let move = wanted === "disposed";
      if (!move && !isOpenDelegation(row))
        move =
          wanted in RANK &&
          row.delivery in RANK &&
          RANK[wanted as keyof typeof RANK] >
            RANK[row.delivery as keyof typeof RANK];
      if (!move) continue;
      row.delivery = wanted;
      if (wanted === "queued")
        row.deliveryMessage = input.queuedMessage ?? null;
      this.note(row, input.by ?? "app", "delivery");
      changed.push(this.copy(row));
    }
    return changed;
  }

  async cancel(ids: string[], reason?: string, by?: string) {
    this.calls.push(`cancel:${ids.join(",")}:${by ?? "app"}`);
    const changed: Delegation[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row || !isOwed(row)) continue;
      if (isOpenDelegation(row))
        Object.assign(row, {
          state: "cancelled",
          error: reason ?? "Stopped by its owner.",
          pendingQuestion: null,
          settledAt: this.now,
          ...UNSTALLED,
        });
      row.delivery = "disposed";
      this.note(row, by ?? "app", "cancelled");
      changed.push(this.copy(row));
    }
    return changed;
  }

  async refuse(id: string) {
    return { applied: false, row: this.rows.get(id) ?? null };
  }

  async listOpen() {
    return [...this.rows.values()].filter(isOwed).map(this.copy);
  }

  async tree(id: string) {
    const root = this.rows.get(id)?.rootId;
    return [...this.rows.values()]
      .filter((row) => row.rootId === root)
      .map(this.copy);
  }

  async recent(since: number) {
    return [...this.rows.values()]
      .filter((row) => isOwed(row) || row.updatedAt >= since)
      .reverse()
      .map(this.copy);
  }

  async owned(query: OwnedQuery) {
    const mine = [...this.rows.values()].filter(
      (row) => row.ownerSession === query.ownerSession,
    );
    if (!query.ids?.length && !query.requestIds?.length)
      return mine.filter(isOwed).reverse().map(this.copy);
    return mine
      .filter(
        (row) =>
          query.ids?.includes(row.id) ||
          query.requestIds?.includes(row.requestId),
      )
      .map(this.copy);
  }

  async reportsSeen() {
    return [];
  }

  async bindChat(_input: ChatBindInput) {
    return true;
  }

  /** delegations.rs `set_stall`: only a running row of that generation, once per kind. */
  async noteRedo(ownerSession: string, id: string, task: string) {
    this.calls.push(`redo:${id}:${task}`);
    const row = this.rows.get(id);
    if (!row || row.ownerSession !== ownerSession) throw new Error("no task of yours has that id");
    if (row.id === task) throw new Error("a task can't redo itself");
    this.note(row, `owner:${ownerSession}`, "lead_redo", { task });
    return { applied: true, row: this.copy(row) };
  }

  async setStall(input: StallInput) {
    this.calls.push(`stall:${input.id}:${input.kind ?? "clear"}`);
    const row = this.rows.get(input.id);
    if (!row) return { applied: false, row: null };
    const kind = input.kind ?? null;
    const same = (row.stallKind ?? null) === kind && (!kind || (row.stallReason ?? null) === (input.reason ?? null));
    if (row.state !== "running" || row.generation !== input.generation || same)
      return { applied: false, row: this.copy(row) };
    if (kind)
      Object.assign(row, {
        stallKind: kind,
        stallReason: input.reason ?? null,
        stalledAt: input.since ?? this.now,
      });
    else Object.assign(row, UNSTALLED);
    this.note(row, input.by ?? "app", kind ? "stalled" : "unstalled");
    return { applied: true, row: this.copy(row) };
  }
}

const UNSTALLED = { stallKind: null, stallReason: null, stalledAt: null };
