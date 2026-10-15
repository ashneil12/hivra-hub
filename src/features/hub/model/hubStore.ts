// The hub's live data: projects, Needs, "Since" and Ash's last-active time, read from Ash OS through the Rust
// `hub` plugin and kept current by its change feed.
//
// - One store, read through `useSyncExternalStore` (see hubData.ts). It starts when the first screen subscribes and
//   stops shortly after the last one leaves.
// - Updates land in place. Needs keep the order Ash already sees: a new row joins at the bottom of its group, a row
//   that was answered anywhere ticks itself off where it stands and stays until Ash leaves the page.
// - Down is a state, not an error: "Ash OS isn't running", retried quietly with a backoff, plus one button.
// - No timers move data. The only timers are retries, the 30-second fallback poll while the feed is down, and the
//   short pause that folds a burst of events into one read.
import { toHubError, type HubFeedEvent, type HubFeedState, type HubTransport } from "./hubTransport";
import type { HubConnection, HubProject, Need, NeedActionType, ProjectIconShape, SinceSummary } from "./types";

export type NeedRows = { shown: Need[]; later: Need[] };

export type SinceData = {
  /** ISO time the summary starts from. */
  sinceAt?: string;
  /** True when there is no earlier visit on record and Ash OS used the last 24 hours. */
  assumed: boolean;
  /** The model's nicer text is still being written; a `hub.since.ready` event follows. */
  pending: boolean;
  overall: SinceSummary;
  byProject: Record<string, SinceSummary>;
};

export type HubSnapshot = {
  status: HubConnection["status"];
  message?: string;
  retrying: boolean;
  /** True once a full read has worked at least once. */
  loadedOnce: boolean;
  projects: HubProject[];
  needs: Record<string, NeedRows>;
  setup: Need[];
  since?: SinceData;
  lastActiveAt?: string;
  sinceAt?: string;
  /** The change feed's own number: the last event this store has seen. */
  seq: number;
};

export type HubStoreOptions = {
  transport: HubTransport;
  /** Pause before a burst of events turns into reads. */
  coalesceMs?: number;
  /** How long after the feed drops before checking Ash OS is still there. */
  healthMs?: number;
  /** Poll interval while the feed is down. */
  pollMs?: number;
  /** Retry delays while Ash OS is down; the last one repeats. */
  retryMs?: number[];
  /** How long the store keeps running after the last screen leaves. */
  stopGraceMs?: number;
  /** Runs when the store starts; what it returns runs when the store stops (the activity tracker lives here). */
  whileRunning?: (store: HubStore) => (() => void) | void;
};

const ICONS: readonly ProjectIconShape[] = ["ghost", "sparkles", "palette", "gauge", "folder"];
const ACTIONS: readonly NeedActionType[] = ["start", "open", "sign_in", "see_options"];

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function mapProject(raw: unknown): HubProject | undefined {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return undefined;
  const name = str(r.name, id);
  const icon = ICONS.find((i) => i === r.iconShape) ?? "folder";
  return { id, name, shortName: str(r.shortName, name), iconShape: icon, folder: optStr(r.folder) ?? null };
}

export function mapNeed(raw: unknown, later = false): Need | undefined {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return undefined;
  const actionType = ACTIONS.find((a) => a === r.actionType) ?? "open";
  const need: Need = {
    id,
    projectId: str(r.projectId),
    title: str(r.title),
    why: str(r.why),
    actionType,
    actionLabel: str(r.actionLabel, "Open"),
    state: r.state === "done" ? "done" : "open",
  };
  const target = optStr(r.actionTarget);
  if (target) need.actionTarget = target;
  if (later || r.later === true) need.later = true;
  const since = optStr(r.since);
  if (since) need.since = since;
  const detail = optStr(r.detail);
  if (detail) need.detail = detail;
  if (need.state === "done") {
    const doneAt = optStr(r.doneAt);
    if (doneAt) need.doneAt = doneAt;
    const reason = optStr(r.doneReason);
    if (reason) need.doneReason = reason;
  }
  return need;
}

function mapSummary(raw: unknown): SinceSummary & { detailLines: string[] } {
  const r = obj(raw);
  return {
    plainText: str(r.plainText),
    details: str(r.details),
    detailLines: arr(r.detailLines).filter((l): l is string => typeof l === "string"),
  };
}

/**
 * Put a fresh list in the order Ash already sees. Rows still there keep their place; a row that was answered
 * becomes a tick in the same place (until `dismissed`); anything new joins at the bottom.
 */
export function mergeStable(prev: Need[], incoming: Need[], done: Map<string, Need>, dismissed: Set<string>): Need[] {
  const open = new Map(incoming.map((n) => [n.id, n]));
  const out: Need[] = [];
  const used = new Set<string>();
  for (const old of prev) {
    const now = open.get(old.id);
    const ticked = done.get(old.id) ?? (old.state === "done" ? old : undefined);
    if (now) {
      out.push(now);
      used.add(old.id);
    } else if (ticked && !dismissed.has(old.id)) {
      out.push({ ...ticked, state: "done" });
      used.add(old.id);
    }
  }
  for (const n of incoming) if (!used.has(n.id)) out.push(n);
  return out;
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export class HubStore {
  private snap: HubSnapshot = {
    status: "loading",
    retrying: false,
    loadedOnce: false,
    projects: [],
    needs: {},
    setup: [],
    seq: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly t: HubTransport;
  private readonly coalesceMs: number;
  private readonly healthMs: number;
  private readonly pollMs: number;
  private readonly retryMs: number[];
  private readonly stopGraceMs: number;
  private readonly whileRunning?: HubStoreOptions["whileRunning"];
  private endRunning?: () => void;

  private running = false;
  private gen = 0;
  private feedClose?: () => void;
  private feedUp = false;
  private lastEventSeq = 0;
  private dismissed = new Set<string>();
  private queue = new Set<"needs" | "projects" | "since" | "all">();
  private timers = { coalesce: 0 as unknown, health: 0 as unknown, retry: 0 as unknown, stop: 0 as unknown, pending: 0 as unknown };
  private attempts = 0;
  private inflight?: Promise<void>;

  constructor(options: HubStoreOptions) {
    this.t = options.transport;
    this.coalesceMs = options.coalesceMs ?? 120;
    this.healthMs = options.healthMs ?? 3_000;
    this.pollMs = options.pollMs ?? 30_000;
    this.retryMs = options.retryMs ?? [3_000, 5_000, 10_000, 20_000, 30_000];
    this.stopGraceMs = options.stopGraceMs ?? 1_000;
    this.whileRunning = options.whileRunning;
  }

  // ---- reading ---------------------------------------------------------------------------------------------------
  getSnapshot = (): HubSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.cancel("stop");
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.timers.stop = setTimeout(() => !this.listeners.size && this.stop(), this.stopGraceMs);
    };
  };

  connection = (): HubConnection => {
    const { status, message, retrying } = this.snap;
    return { status, ...(message ? { message } : {}), ...(retrying ? { retrying } : {}) };
  };

  private patch(next: Partial<HubSnapshot>): void {
    const changed = (Object.keys(next) as (keyof HubSnapshot)[]).some((k) => !same(this.snap[k], next[k]));
    if (!changed) return;
    this.snap = { ...this.snap, ...next };
    this.listeners.forEach((l) => l());
  }

  // ---- running ---------------------------------------------------------------------------------------------------
  start(): void {
    if (this.running) return;
    this.running = true;
    this.gen += 1;
    this.endRunning = this.whileRunning?.(this) ?? undefined;
    void this.loadAll();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.gen += 1;
    (Object.keys(this.timers) as (keyof typeof this.timers)[]).forEach((k) => this.cancel(k));
    this.closeFeed();
    this.endRunning?.();
    this.endRunning = undefined;
    this.queue.clear();
    this.inflight = undefined;
  }

  /** "Try again": read everything now. */
  retry(): void {
    if (!this.running) this.start();
    this.cancel("retry");
    this.patch({ retrying: true });
    void this.loadAll();
  }

  private cancel(name: keyof typeof this.timers): void {
    clearTimeout(this.timers[name] as ReturnType<typeof setTimeout>);
    this.timers[name] = 0;
  }

  private alive(gen: number): boolean {
    return this.running && gen === this.gen;
  }

  // ---- reads -----------------------------------------------------------------------------------------------------
  /** Projects, Needs, then (without waiting for it) Since. */
  loadAll(): Promise<void> {
    if (this.inflight) return this.inflight;
    const gen = this.gen;
    const run = async () => {
      try {
        const [projects, needs] = await Promise.all([this.t.call("ash-hub-projects", {}), this.t.call("ash-hub-needs", {})]);
        if (!this.alive(gen)) return;
        this.applyProjects(projects);
        this.applyNeeds(needs);
        const seq = Math.max(this.snap.seq, Number(obj(projects).seq) || 0, Number(obj(needs).seq) || 0);
        this.attempts = 0;
        this.cancel("retry");
        this.patch({ status: "ready", message: undefined, retrying: false, loadedOnce: true, seq });
        if (!this.feedClose || !this.feedUp) this.openFeed();
        void this.loadSince();
      } catch (error) {
        if (this.alive(gen)) this.fail(error);
      } finally {
        if (this.gen === gen) this.inflight = undefined;
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  async loadNeeds(): Promise<void> {
    const gen = this.gen;
    try {
      const needs = await this.t.call("ash-hub-needs", {});
      if (this.alive(gen)) {
        this.applyNeeds(needs);
        this.patch({ seq: Math.max(this.snap.seq, Number(obj(needs).seq) || 0) });
      }
    } catch (error) {
      if (this.alive(gen)) this.fail(error);
    }
  }

  async loadProjects(): Promise<void> {
    const gen = this.gen;
    try {
      const projects = await this.t.call("ash-hub-projects", {});
      if (this.alive(gen)) this.applyProjects(projects);
    } catch (error) {
      if (this.alive(gen)) this.fail(error);
    }
  }

  /** The summary. A short wait lets the model's text arrive in the same call when it is quick. */
  async loadSince(wait = 1): Promise<void> {
    const gen = this.gen;
    try {
      const raw = obj(await this.t.call("ash-hub-since", { wait }));
      if (!this.alive(gen)) return;
      const summary = obj(raw.summary);
      const overall = mapSummary(summary);
      const byProject: Record<string, SinceSummary> = {};
      for (const [id, v] of Object.entries(obj(raw.projects))) {
        const s = mapSummary(v);
        byProject[id] = { plainText: s.plainText, details: s.details };
      }
      const pending = summary.pending === true;
      this.patch({
        since: {
          sinceAt: optStr(raw.sinceAt),
          assumed: raw.assumed === true,
          pending,
          overall: { plainText: overall.plainText, details: overall.details },
          byProject,
        },
        sinceAt: optStr(raw.sinceAt),
        lastActiveAt: optStr(raw.lastActiveAt) ?? this.snap.lastActiveAt,
      });
      this.cancel("pending");
      // The event normally brings the finished text; this is the belt to that braces.
      if (pending) this.timers.pending = setTimeout(() => void this.loadSince(0), 8_000);
    } catch (error) {
      if (this.alive(gen)) this.fail(error);
    }
  }

  // ---- applying --------------------------------------------------------------------------------------------------
  private applyProjects(raw: unknown): void {
    const projects = arr(obj(raw).projects).map(mapProject).filter((p): p is HubProject => !!p);
    this.patch({ projects });
  }

  private applyNeeds(raw: unknown): void {
    const data = obj(raw);
    const next: Record<string, NeedRows> = {};
    for (const entry of arr(data.projects)) {
      const e = obj(entry);
      const pid = str(e.projectId);
      if (!pid) continue;
      const shown = arr(e.shown).map((n) => mapNeed(n)).filter((n): n is Need => !!n);
      const later = arr(e.later).map((n) => mapNeed(n, true)).filter((n): n is Need => !!n);
      const done = new Map(arr(e.done).map((n) => mapNeed(n)).filter((n): n is Need => !!n).map((n) => [n.id, n] as const));
      const prev = this.snap.needs[pid] ?? { shown: [], later: [] };
      next[pid] = {
        shown: mergeStable(prev.shown, shown, done, this.dismissed),
        later: mergeStable(prev.later, later, new Map(), this.dismissed),
      };
    }
    // A project with nothing left in Ash OS keeps only the ticks Ash has not left behind yet.
    for (const [pid, prev] of Object.entries(this.snap.needs)) {
      if (next[pid]) continue;
      const ticks = prev.shown.filter((n) => n.state === "done" && !this.dismissed.has(n.id));
      if (ticks.length) next[pid] = { shown: ticks, later: [] };
    }
    const setup = arr(data.setup).map((n) => mapNeed(n)).filter((n): n is Need => !!n);
    this.patch({ needs: next, setup });
  }

  /** Ash left the page: ticked-off rows go, and stay gone even while Ash OS still lists them. */
  dismissDone(): void {
    const needs: Record<string, NeedRows> = {};
    let any = false;
    for (const [pid, rows] of Object.entries(this.snap.needs)) {
      for (const n of rows.shown) {
        if (n.state !== "done") continue;
        this.dismissed.add(n.id);
        any = true;
      }
      needs[pid] = { shown: rows.shown.filter((n) => n.state !== "done"), later: rows.later };
    }
    if (any) this.patch({ needs });
  }

  // ---- the change feed -------------------------------------------------------------------------------------------
  private openFeed(): void {
    this.closeFeed();
    this.feedClose = this.t.openFeed(this.snap.seq, {
      onEvent: (e) => this.onEvent(e),
      onState: (s) => this.onFeedState(s),
    });
  }

  private closeFeed(): void {
    this.feedClose?.();
    this.feedClose = undefined;
    this.feedUp = false;
  }

  private onFeedState(s: HubFeedState): void {
    if (!this.running) return;
    if (s.connected) {
      this.feedUp = true;
      this.cancel("health");
      if (s.reset) {
        this.lastEventSeq = 0;
        this.patch({ seq: s.latest ?? 0 });
        void this.loadAll();
      }
      return;
    }
    this.feedUp = false;
    if (!this.timers.health) this.timers.health = setTimeout(() => void this.checkHealth(), this.healthMs);
  }

  /** The feed is down: is Ash OS still there? Keep reading changes by polling while it is. */
  private async checkHealth(): Promise<void> {
    this.timers.health = 0;
    if (!this.running || this.feedUp) return;
    const gen = this.gen;
    try {
      const out = obj(await this.t.call("ash-hub-events", { after: this.snap.seq, timeout: 0 }));
      if (!this.alive(gen) || this.feedUp) return;
      if (out.reset === true) {
        this.lastEventSeq = 0;
        this.patch({ seq: Number(out.latest) || 0 });
        await this.loadAll();
      } else {
        for (const e of arr(out.events)) this.onEvent(e as HubFeedEvent);
        if (this.snap.status !== "ready") await this.loadAll();
      }
      this.timers.health = setTimeout(() => void this.checkHealth(), this.pollMs);
    } catch (error) {
      if (this.alive(gen)) this.fail(error);
    }
  }

  private onEvent(e: HubFeedEvent): void {
    if (!this.running || typeof e.seq !== "number" || e.seq <= this.lastEventSeq) return;
    this.lastEventSeq = e.seq;
    this.patch({ seq: Math.max(this.snap.seq, e.seq) });
    const topics = new Set(e.topics ?? []);
    if (e.kind === "hub.code.version" || topics.has("service")) this.queue.add("all");
    if (topics.has("needs")) this.queue.add("needs");
    if (topics.has("projects")) this.queue.add("projects");
    if (topics.has("since") || topics.has("activity")) this.queue.add("since");
    if (this.queue.size && !this.timers.coalesce) this.timers.coalesce = setTimeout(() => void this.flush(), this.coalesceMs);
  }

  private async flush(): Promise<void> {
    this.timers.coalesce = 0;
    const wanted = new Set(this.queue);
    this.queue.clear();
    if (wanted.has("all")) return void (await this.loadAll());
    await Promise.all([
      wanted.has("needs") ? this.loadNeeds() : undefined,
      wanted.has("projects") ? this.loadProjects() : undefined,
      wanted.has("since") ? this.loadSince(0) : undefined,
    ]);
  }

  // ---- down ------------------------------------------------------------------------------------------------------
  private fail(error: unknown): void {
    const e = toHubError(error);
    // Ash OS answered and said no to one call: not an outage, unless nothing has ever loaded.
    if (!e.isDown && this.snap.loadedOnce) {
      this.patch({ retrying: false });
      return;
    }
    this.patch({ status: "unreachable", message: e.message, retrying: false });
    if (!this.running || this.timers.retry) return;
    const wait = this.retryMs[Math.min(this.attempts, this.retryMs.length - 1)];
    this.attempts += 1;
    this.timers.retry = setTimeout(() => {
      this.timers.retry = 0;
      void this.loadAll();
    }, wait);
  }

  // ---- Ash's activity --------------------------------------------------------------------------------------------
  /** Ash really used the app (typing, clicking, focus) at `at`. Tell Ash OS; a failure here is never shown. */
  async reportActive(at: Date): Promise<void> {
    if (!this.running) return;
    const gen = this.gen;
    try {
      const out = obj(await this.t.call("ash-hub-active", { at: at.toISOString() }));
      if (!this.alive(gen)) return;
      const sinceAt = optStr(out.sinceAt);
      const moved = sinceAt !== this.snap.sinceAt;
      this.patch({ lastActiveAt: optStr(out.lastActiveAt), sinceAt });
      if (moved) void this.loadSince(0);
    } catch {
      /* the app's next read finds out if Ash OS is down */
    }
  }
}
