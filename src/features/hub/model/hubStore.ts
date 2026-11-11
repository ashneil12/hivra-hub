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
import type {
  AnswerState, HubAnswer, HubChangeRecord, HubChangeSide, HubConnection, HubJob, HubJobGroup, HubProject, HubQuestion, JobOption, JobOptions, JobWireState, Need, NeedActionType,
  OlderDismissed, SinceSummary, TodaySection, TodaySectionKind,
} from "./types";
import { toShape } from "./projectShapes";
import { mapChecks, type HubCheck } from "./hubChecks";
import { LEGACY_TODAY_CARDS, NEEDS_YOU_CARD } from "./todayCards";

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
  /** Older questions: not Needs, in no count. Newest first, as Ash OS lists them. */
  older: Need[];
  /** Being built, grouped under the Mono running each job. Stable order. */
  jobs: HubJobGroup[];
  /** Answers on their way or just back, by Needs row id. */
  answering: Record<string, AnswerState>;
  since?: SinceData;
  lastActiveAt?: string;
  sinceAt?: string;
  /** The change feed's own number: the last event this store has seen. */
  seq: number;
  /** Ash OS's pages (`pages`, kept and removed), as it sends them; the Pages store reads them. Undefined until read. */
  pages?: unknown[];
  /** The Today board's sections (`layout`). Undefined until read, or on a service without it. */
  today?: TodaySection[];
  /** Change the hub / Edit Today history (`changes`), newest first. Undefined until read. */
  changes?: HubChangeRecord[];
};

/** What a write makes the store read again at once (the feed would bring it a moment later anyway). */
export type HubSlice = "needs" | "projects" | "since" | "jobs" | "pages" | "layout" | "changes" | "checks";

export type HubStoreOptions = {
  transport: HubTransport;
  /** Pause before a burst of events turns into reads. */
  coalesceMs?: number;
  /** At most one round of change-driven reads this often: Ash OS's feed also reports every ledger write. */
  minGapMs?: number;
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

const TODAY_KINDS: readonly TodaySectionKind[] = ["since", "setup", "needs", "being-built", "page"];
const CHANGE_STATES: readonly HubChangeRecord["state"][] = ["preview", "applied", "undone", "discarded"];
const ACTIONS: readonly NeedActionType[] = ["start", "open", "sign_in", "see_options", "accept"];

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
  const icon = toShape(r.iconShape);
  return { id, name, shortName: str(r.shortName, name), iconShape: icon, folder: optStr(r.folder) ?? null, ...(r.status === "parked" ? { parked: true } : {}), ...(r.shared === true ? { shared: true } : {}) };
}

/**
 * Ash OS's words with its internal tags taken out (Board 22 Oct: "Autofix: health: ..." on Today). A job about a job
 * keeps the inner job's tags mid-sentence ("Fixing a studio health problem: running 10h: Autofix: health: light
 * surface…"); the tags go, the words stay. A tag at the very start is Ash OS's to turn into words, so it stays.
 */
export function plainWorkText(text: string): string {
  return text
    .replace(/([:;])\s*(?:autofix|harness)\s*:\s*(?:health\s*:\s*)?/gi, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Developer detail a job or need title can carry from Ash OS (a JS expression, an HTTP status line, an exception, a
// stack frame, a file path): Ash reads the ask, not the log line.
const DEV_TEXT =
  /(?:\bwindow\.|\b__\w|\b[\w$]+\.[\w$]+(?:\.[\w$]+)*\s*\(|\bHTTP(?:\s+Error)?\s*\d{3}|\b[A-Z]\w*(?:Error|Exception)\b|\bTraceback\b|\bat\s+\S+:\d+|[{}<>]|=>|(?:^|\s)(?:~|\/)[\w.-]+\/)/;

/** A job or need title in plain words: the summary of the ask, without the developer detail Ash OS appends. */
export function plainTitle(text: string): string {
  const clean = plainWorkText(text).replace(/(?:…|\.\.\.)\s*$/, "").trim();
  const parts = clean.split(/:\s+/);
  // After "X did not boot" (or failed / crashed) comes the error itself, whatever it looks like.
  const failed = parts.findIndex((part) => /\b(?:did not boot|failed|crashed)$/i.test(part));
  const dev = parts.findIndex((part) => DEV_TEXT.test(part));
  const cut = Math.min(...[failed === -1 ? parts.length : failed + 1, dev === -1 ? parts.length : dev]);
  const kept = parts.slice(0, cut).map((part) =>
    part
      .replace(/^light surface\s+(\S+)\s+did not boot$/i, "the $1 screen won't open")
      .replace(/^(?:surface|page)\s+(\S+)\s+did not boot$/i, "the $1 screen won't open"),
  );
  const title = kept.join(": ").trim();
  return title || "A fix in progress";
}

export function mapNeed(raw: unknown, later = false): Need | undefined {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return undefined;
  const actionType = ACTIONS.find((a) => a === r.actionType) ?? "open";
  const need: Need = {
    id,
    projectId: str(r.projectId),
    title: plainTitle(str(r.title)),
    why: plainWorkText(str(r.why)),
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
  if (detail) need.detail = plainWorkText(detail);
  if (r.circle === "amber" || r.circle === "red") need.circle = r.circle;
  const word = optStr(r.word);
  if (word) need.word = word;
  if (target?.startsWith("job:")) need.jobId = target.slice(4);
  // Only a "Looks right" row (finished critical work, id `s:<ask>`) can be marked seen.
  if (id.startsWith("s:")) need.canMarkSeen = true;
  if (need.state === "done") {
    const doneAt = optStr(r.doneAt);
    if (doneAt) need.doneAt = doneAt;
    const reason = optStr(r.doneReason);
    if (reason) need.doneReason = reason;
  }
  return need;
}

const JOB_STATES: readonly JobWireState[] = ["working", "checking", "waiting", "stuck", "sent_to_lead", "lead_gave_up", "done", "parked"];

export function mapJob(raw: unknown): HubJob | undefined {
  const r = obj(raw);
  const id = str(r.id);
  const said = str(r.state).trim();
  // A dropped job is never shown. A state this app doesn't know yet still shows, under its own word: a job never
  // vanishes from Being built because Ash OS learned a new word (it once sent `waiting` and the job disappeared).
  if (!id || !said || said === "dropped") return undefined;
  const found = JOB_STATES.find((x) => x === said) ?? "unknown";
  // A red the switched-off studio left that its project's Lead now has (Ash OS marks it `notAshs`): it is the Lead's,
  // not Ash's to act on, so it reads like any job with its Lead, a grey "With <Lead>", never a red Needs you.
  const notAshs = found === "lead_gave_up" && r.notAshs === true;
  const state: HubJob["state"] = notAshs ? "sent_to_lead" : found;
  const job: HubJob = {
    id,
    projectId: str(r.projectId),
    title: plainTitle(str(r.title)),
    lead: optStr(r.lead) ?? null,
    leadName: optStr(r.leadName) ?? null,
    state,
    reason: plainWorkText(str(r.reason)),
    startedAt: str(r.startedAt),
    lastActiveAt: str(r.lastActiveAt, str(r.startedAt)),
    finishedAt: optStr(r.finishedAt) ?? null,
    seen: r.seen === true,
  };
  if (state === "unknown") job.rawState = said.slice(0, 60);
  if (notAshs) job.notAshs = true;
  const sourceRef = optStr(r.sourceRef);
  if (sourceRef) job.sourceRef = sourceRef;
  if (r.circle === "amber" || r.circle === "red") job.circle = r.circle;
  const word = optStr(r.word);
  if (word) job.word = word;
  const sentText = optStr(r.sentText);
  if (sentText) job.sentText = sentText;
  const gotIt = obj(r.gotIt);
  if (optStr(gotIt.text)) job.gotIt = { at: str(gotIt.at), text: str(gotIt.text) };
  const tried = arr(r.tried).filter((t): t is string => typeof t === "string");
  if (tried.length) job.tried = tried;
  const why = optStr(r.why);
  if (why) job.why = why;
  const retryAt = optStr(r.retryAt);
  if (retryAt) job.retryAt = retryAt;
  // A part of a bigger job (one of its workers): folded into one row in Being built.
  const parentId = optStr(r.parentId);
  if (parentId) {
    job.parentId = parentId;
    const parentTitle = optStr(r.parentTitle);
    if (parentTitle) job.parentTitle = plainTitle(parentTitle);
  }
  return job;
}

/** Old cards a saved board may still carry: a separate "stuck" card is now part of the one Needs you section. */
const LEGACY_TODAY_KINDS: Readonly<Record<string, TodaySectionKind>> = { stuck: "needs" };

/**
 * Today's sections as Ash OS sends them; anything it doesn't know is left out, never guessed at. A board saved with the
 * old cards ("Stuck: needs you", "Needs (up to 5)", "Decisions (up to 5)", or a "stuck" card) still loads: they are one
 * Needs you section now, shown once where the first of them was (Critiquito, 22 Oct).
 */
export function mapToday(raw: unknown): TodaySection[] {
  const seen = new Set<string>();
  let needs = false;
  return arr(raw).flatMap((v): TodaySection[] => {
    const r = obj(v);
    const kind = TODAY_KINDS.find((k) => k === r.kind) ?? (typeof r.kind === "string" ? LEGACY_TODAY_KINDS[r.kind] : undefined);
    const id = str(r.id);
    if (!kind || !id || seen.has(id) || typeof r.title !== "string") return [];
    if (kind === "page" && !optStr(r.pageId)) return [];
    seen.add(id);
    if (kind === "needs") {
      if (needs) return [];
      needs = true;
      const title = LEGACY_TODAY_CARDS[r.title] ?? (r.kind === "needs" ? r.title : NEEDS_YOU_CARD);
      return [{ id, kind, title }];
    }
    return [{ id, kind, title: r.title, ...(kind === "page" ? { pageId: str(r.pageId) } : {}) }];
  });
}

function mapSide(raw: unknown): HubChangeSide {
  const r = obj(raw);
  return {
    ...(optStr(r.image) ? { image: str(r.image) } : {}),
    sections: arr(r.sections).map((x) => {
      const sec = obj(x);
      return { title: str(sec.title), rows: arr(sec.rows).filter((t): t is string => typeof t === "string") };
    }),
  };
}

/** One change from Ash OS's history (`changes`). */
export function mapChange(raw: unknown): HubChangeRecord | undefined {
  const r = obj(raw);
  const previewId = str(r.previewId);
  const state = CHANGE_STATES.find((x) => x === r.state);
  const flow = r.flow === "hub" || r.flow === "today" || r.flow === "connect" ? r.flow : undefined;
  if (!previewId || !state || !flow) return undefined;
  return {
    previewId,
    title: str(r.title),
    by: str(r.by, str(r.monoId)),
    monoId: str(r.monoId),
    flow,
    projectId: str(r.projectId, "today"),
    state,
    prompt: str(r.prompt),
    createdAt: str(r.createdAt),
    ...(optStr(r.appliedAt) ? { appliedAt: str(r.appliedAt) } : {}),
    ...(optStr(r.undoneAt) ? { undoneAt: str(r.undoneAt) } : {}),
    now: mapSide(r.now),
    preview: mapSide(r.preview),
    log: arr(r.log).map((x) => {
      const l = obj(x);
      return { at: str(l.at), what: str(l.what), by: str(l.by), ...(optStr(l.note) ? { note: str(l.note) } : {}) };
    }),
  };
}

/** Same order Ash already sees: groups and jobs still there keep their place, new ones join at the end. */
export function mergeJobGroups(prev: HubJobGroup[], next: HubJobGroup[]): HubJobGroup[] {
  const key = (g: HubJobGroup) => `${g.projectId}|${g.leadId ?? ""}`;
  const incoming = new Map(next.map((g) => [key(g), g]));
  const out: HubJobGroup[] = [];
  const used = new Set<string>();
  const merge = (old: HubJobGroup | undefined, g: HubJobGroup): HubJobGroup => {
    if (!old) return g;
    const byId = new Map(g.jobs.map((j) => [j.id, j]));
    const kept = old.jobs.flatMap((j) => (byId.has(j.id) ? [byId.get(j.id)!] : []));
    const keptIds = new Set(kept.map((j) => j.id));
    return { ...g, jobs: [...kept, ...g.jobs.filter((j) => !keptIds.has(j.id))] };
  };
  for (const old of prev) {
    const g = incoming.get(key(old));
    if (g) {
      out.push(merge(old, g));
      used.add(key(old));
    }
  }
  for (const g of next) if (!used.has(key(g))) out.push(g);
  return out;
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
    older: [],
    jobs: [],
    answering: {},
    seq: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly t: HubTransport;
  private readonly coalesceMs: number;
  private readonly minGapMs: number;
  private lastFlush = 0;
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
  private queue = new Set<HubSlice | "all">();
  private timers = { coalesce: 0 as unknown, health: 0 as unknown, retry: 0 as unknown, stop: 0 as unknown, pending: 0 as unknown };
  private attempts = 0;
  private inflight?: Promise<void>;

  constructor(options: HubStoreOptions) {
    this.t = options.transport;
    this.coalesceMs = options.coalesceMs ?? 120;
    this.minGapMs = options.minGapMs ?? 1_000;
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
        const [projects, needs] = await Promise.all([this.t.call("projects", {}), this.t.call("needs", {})]);
        if (!this.alive(gen)) return;
        this.applyProjects(projects);
        this.applyNeeds(needs);
        const seq = Math.max(this.snap.seq, Number(obj(projects).seq) || 0, Number(obj(needs).seq) || 0);
        this.attempts = 0;
        this.cancel("retry");
        this.patch({ status: "ready", message: undefined, retrying: false, loadedOnce: true, seq });
        if (!this.feedClose || !this.feedUp) this.openFeed();
        void this.loadSince();
        void this.loadJobs();
        void this.loadPages();
        void this.loadLayout();
        void this.loadChanges();
        void this.loadChecks();
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
      const needs = await this.t.call("needs", {});
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
      const projects = await this.t.call("projects", {});
      if (this.alive(gen)) this.applyProjects(projects);
    } catch (error) {
      if (this.alive(gen)) this.fail(error);
    }
  }

  /** Since was Ash OS's summary of what changed while Ash was away. Retired with the bridge (WP-04): nothing to read. */
  async loadSince(_wait = 1): Promise<void> {}

  /** Being built. A service without jobs yet ("Unknown hub action") just means nothing is being built. */
  async loadJobs(): Promise<void> {
    const gen = this.gen;
    try {
      const raw = obj(await this.t.call("jobs", {}));
      if (!this.alive(gen)) return;
      const groups = arr(raw.groups).map((g): HubJobGroup => {
        const r = obj(g);
        return {
          leadId: optStr(r.leadId) ?? null,
          leadName: str(r.leadName, "Nobody yet"),
          projectId: str(r.projectId),
          jobs: arr(r.jobs).map(mapJob).filter((j): j is HubJob => !!j),
        };
      });
      this.patch({ jobs: mergeJobGroups(this.snap.jobs, groups.filter((g) => g.jobs.length)) });
    } catch (error) {
      const e = toHubError(error);
      if (e.isDown && this.alive(gen)) this.fail(error);
    }
  }

  /**
   * Pages, the Today board and the change history. A service without them ("Unknown hub action", or the read-only
   * proxy of an older dev setup) leaves the slice unset: Pages and Today then draw what they have.
   */
  async loadPages(): Promise<void> {
    await this.loadOptional("pages", { include_removed: true }, (raw) => this.patch({ pages: arr(obj(raw).pages) }));
  }

  async loadLayout(): Promise<void> {
    await this.loadOptional("layout", {}, (raw) => {
      const today = mapToday(obj(raw).today);
      if (today.length) this.patch({ today });
    });
  }

  /** Change the hub's history was Ash OS's. Retired with the bridge (WP-04): nothing to read. */
  async loadChanges(): Promise<void> {}

  private async loadOptional(action: string, payload: Record<string, unknown>, apply: (raw: unknown) => void): Promise<void> {
    const gen = this.gen;
    try {
      const raw = await this.t.call(action, payload);
      if (this.alive(gen)) apply(raw);
    } catch (error) {
      const e = toHubError(error);
      if (e.isDown && this.alive(gen)) this.fail(error);
    }
  }

  // ---- checks (docs/PHASE-2-DESIGN.md decision 4; hubChecks.ts, app/hooks/useHubChecks.ts) --------------------------
  private checks: HubCheck[] = [];
  private readonly checkListeners = new Set<(checks: readonly HubCheck[]) => void>();

  /** Every pull of the checks not yet delivered (at boot, and on feed topic `checks`); called at once with the last. */
  onChecks(listener: (checks: readonly HubCheck[]) => void): () => void {
    this.checkListeners.add(listener);
    if (this.checks.length) listener(this.checks);
    return () => this.checkListeners.delete(listener);
  }

  /** The checker's notes for the chats this app runs that Ash OS hasn't heard delivered. An older service has none. */
  async loadChecks(): Promise<void> {
    await this.loadOptional("checks", { limit: 50 }, (raw) => {
      this.checks = mapChecks(raw);
      this.checkListeners.forEach((listener) => listener(this.checks));
    });
  }

  /** The app handed these checks to their chats as turns: Ash OS marks each delivered once. */
  async checksDelivered(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.t.call("check-delivered", { ids: [...ids] });
    this.checks = this.checks.filter((check) => !ids.includes(check.id));
  }

  /** Read these slices again now (after a write; the feed would bring them a moment later). */
  async reload(slices: readonly HubSlice[]): Promise<void> {
    const load: Record<HubSlice, () => Promise<void>> = {
      needs: () => this.loadNeeds(),
      projects: () => this.loadProjects(),
      since: () => this.loadSince(0),
      jobs: () => this.loadJobs(),
      pages: () => this.loadPages(),
      layout: () => this.loadLayout(),
      changes: () => this.loadChanges(),
      checks: () => this.loadChecks(),
    };
    await Promise.all([...new Set(slices)].map((s) => load[s]()));
  }

  /**
   * One call Ash's tap makes (keep a page, apply a change, create a project, ...), then the slices it moves are read
   * again. A refusal comes back as the thrown HubCallError, in Ash OS's own words.
   */
  async act<T = unknown>(action: string, payload: Record<string, unknown>, reload: readonly HubSlice[] = []): Promise<T> {
    const out = await this.t.call<T>(action, payload);
    if (this.running && reload.length) await this.reload(reload);
    return out;
  }

  // ---- Ash's choices ---------------------------------------------------------------------------------------------
  /** "Looks right" rows: Ash has seen it. Ash OS ticks the row off; the answer is read at once, the feed follows. */
  async markNeedSeen(id: string): Promise<void> {
    await this.t.call("need-seen", { id });
    await this.loadNeeds();
  }

  /** A question's sheet (`question`), by its Needs row id. */
  async question(needId: string): Promise<HubQuestion> {
    const raw = obj(await this.t.call("question", { id: needId }));
    const rec = obj(raw.recommendation);
    const status = raw.status === "answered" || raw.status === "expired" ? raw.status : "open";
    return {
      id: str(raw.id, needId),
      questionId: str(raw.questionId),
      status,
      question: str(raw.question),
      options: arr(raw.options)
        .map((o) => {
          const r = obj(o);
          return { label: str(r.label), ...(optStr(r.detail) ? { detail: str(r.detail) } : {}) };
        })
        .filter((o) => o.label),
      recommendation: { text: str(rec.text), optionIndex: typeof rec.optionIndex === "number" ? rec.optionIndex : null },
      quickAnswers: arr(raw.quickAnswers)
        .map((q) => ({ id: str(obj(q).id), label: str(obj(q).label) }))
        .filter((q) => q.id),
      ...(optStr(raw.askedAt) ? { askedAt: str(raw.askedAt) } : {}),
      ...(optStr(raw.heldAnswer) ? { heldAnswer: str(raw.heldAnswer) } : {}),
    };
  }

  /**
   * Ash's answer (Ash only in Ash OS). It goes in the background: an option or typed answer is read by the model and
   * can take a minute, and nothing else waits for it. The row says "Sending…", then the receipt; it ticks off only when
   * Ash OS says the question closed (`rowDone`).
   */
  answer(needId: string, answer: HubAnswer): void {
    const set = (state: AnswerState) => this.patch({ answering: { ...this.snap.answering, [needId]: state } });
    set({ sending: true });
    void this.t
      .call("answer", { id: needId, ...answer })
      .then(async (raw) => {
        const r = obj(raw);
        set({ sending: false, receipt: str(r.receipt, "Got it."), closed: r.rowDone === true });
        if (r.rowDone === true) await this.loadNeeds();
      })
      .catch((error) => set({ sending: false, problem: toHubError(error).message }));
  }

  /** Sweeping Ash OS's old question queue. Retired with the bridge (WP-04): nothing that old waits here. */
  async dismissOlder(_olderThanDays: number, _projectId?: string): Promise<OlderDismissed> {
    return { dismissed: 0, receipt: "Nothing that old was waiting." };
  }

  /** "Looks right": Ash accepts finished critical work. Ash OS ticks the row off; the answer is read at once. */
  async acceptNeed(id: string): Promise<void> {
    await this.t.call("need-accept", { id });
    await this.loadNeeds();
  }

  /** The "See options" sheet for a job the Lead gave up on. */
  async jobOptions(jobId: string): Promise<JobOptions> {
    const raw = obj(await this.t.call("job-options", { job_id: jobId }));
    return {
      jobId: str(raw.jobId, jobId),
      projectId: str(raw.projectId),
      title: str(raw.title),
      why: str(raw.why),
      options: arr(raw.options).map((o): JobOption => {
        const r = obj(o);
        return { id: str(r.id), label: str(r.label), needsText: r.needsText === true, note: str(r.note), ...(optStr(r.placeholder) ? { placeholder: str(r.placeholder) } : {}) };
      }),
    };
  }

  /** Ash's pick on a given-up job. The job moves and its Needs row ticks off. */
  async jobAct(jobId: string, option: string, hint?: string): Promise<void> {
    await this.t.call("job-act", { job_id: jobId, option, ...(hint ? { hint } : {}) });
    await Promise.all([this.loadNeeds(), this.loadJobs()]);
  }

  /** Ash has seen these finished jobs and left the page. */
  markJobsSeen(jobIds: string[]): void {
    if (!jobIds.length || !this.running) return;
    void this.t
      .call("job-seen", { job_ids: jobIds })
      .then(() => this.loadJobs())
      .catch(() => undefined);
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
    const older = arr(obj(data.older).rows).map((n) => mapNeed(n, true)).filter((n): n is Need => !!n);
    this.patch({ needs: next, setup, older });
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
    // The receipts of answers that are back go too; one still on its way stays.
    const answering = Object.fromEntries(Object.entries(this.snap.answering).filter(([, a]) => a.sending));
    if (any || Object.keys(answering).length !== Object.keys(this.snap.answering).length) this.patch({ needs, answering });
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

  /** The feed is down: read everything again, then keep checking while it stays down. */
  private async checkHealth(): Promise<void> {
    this.timers.health = 0;
    if (!this.running || this.feedUp) return;
    await this.loadAll();
    if (this.running && !this.feedUp) this.timers.health = setTimeout(() => void this.checkHealth(), this.pollMs);
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
    if (topics.has("jobs")) this.queue.add("jobs");
    if (topics.has("pages")) this.queue.add("pages");
    if (topics.has("layout")) this.queue.add("layout");
    if (topics.has("changes")) this.queue.add("changes");
    if (topics.has("checks")) this.queue.add("checks");
    if (this.queue.size && !this.timers.coalesce) {
      const wait = Math.max(this.coalesceMs, this.lastFlush + this.minGapMs - Date.now());
      this.timers.coalesce = setTimeout(() => void this.flush(), wait);
    }
  }

  private async flush(): Promise<void> {
    this.timers.coalesce = 0;
    this.lastFlush = Date.now();
    const wanted = new Set(this.queue);
    this.queue.clear();
    if (wanted.has("all")) return void (await this.loadAll());
    await this.reload([...wanted].filter((w): w is HubSlice => w !== "all"));
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
}
