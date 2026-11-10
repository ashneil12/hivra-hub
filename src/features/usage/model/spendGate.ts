/**
 * WP-176. The stored limits, the usage rows, and the verdicts the launch and turn gates read.
 *
 * One admission point (`admitSpendTurn`) judges every turn before it starts, whatever started it: a habit, an
 * automation, a delegated worker, a person's chat. A project or app limit refuses only the automated runs and warns a
 * person's chat. A per-task ceiling on a billed model refuses any further turn of that run once its total is past the
 * cap. Nothing kills a run that is already going, except the per-task hard cap, which stops that run only.
 *
 * Limits are keyed by the project's hub id. A folder or a working copy under it maps to that id, so a limit saved by
 * name, by folder or from Settings is the same limit.
 */

import { pathKey } from "../../../shared/lib/paths";
import { isBilledModel } from "../../sessions/model/customModels";
import { addReportedCost, cliReportsCost, readTurnPrice, type TurnPrice } from "./cliCost";
import type { UsageSession } from "./history";
import { formatUsd, MICRO, toMicro } from "./money";
import {
  bookFromStored,
  dropLimit,
  emptyBook,
  importSpendLimits,
  inPeriod as inSpendPeriod,
  periodSpend,
  putLimit,
  resetSpendWarnings,
  sameLimit,
  sanitizeSpendLimit,
  spendAllowed,
  spendStatusLine,
  subjectOf,
  warnOnce,
  type SpendBook,
  type SpendLimit,
  type SpendPeriod,
  type SpendReading,
  type SpendScope,
  type SpendVerdict,
  type WarnSink,
} from "./spend";
import { ceilingDecision, sanitizeTaskCeiling, type CeilingVerdict, type TaskCeiling } from "./taskCeiling";

export type { SpendVerdict } from "./spend";

const LOCAL_KEY = "monocode:spend-limits";
/** Rows are read again after this long. A check in between uses what it has. */
const TTL_MS = 5_000;
/** Rows older than this are not trusted: a check reports unreadable instead of an old total. */
const STALE_MS = 10 * 60_000;

export const RAISE_LIMIT = "Raise limit";

export type SpendWriter = "person" | "first-mate" | "habit" | "worker" | "checker";
export type ChatKind = "chat" | "mono" | "team" | "habit" | "worker";

export type SpendSinkEvent = { kind: string; summary: string; project: string };

type Ledger = { key: string; sessionId: string; at: number; micros: number; priced: boolean };
type Stored = { book: SpendBook; ceilings: Record<string, TaskCeiling> };
type ProjectLookup = {
  /** The hub id of the project a folder belongs to. */
  idOf(folder: string): string | undefined;
  /** The folder of a hub project id. */
  folderOf(id: string): string | undefined;
  /** The project's first mate chat, which hears a warning. */
  firstMateOf?(key: string): string | undefined;
};

const UNSET: SpendVerdict = { status: "unset", reason: "" };
const OK: SpendVerdict = { status: "ok", reason: "" };
const UNMEASURED: SpendVerdict = {
  status: "unmeasured",
  reason: "This CLI reports no cost, so this limit cannot count its work.",
};
const UNREADABLE_STORE: SpendVerdict = {
  status: "over",
  reason: "Spend limits could not be read from storage. New builders wait until you replace them in Settings.",
};
const NO_PROJECTS: ProjectLookup = { idOf: () => undefined, folderOf: () => undefined };

let booted = false;
let book: SpendBook = emptyBook();
let ceilings: Record<string, TaskCeiling> = {};
let storeUnreadable = false;
let sessions: UsageSession[] | null = null;
let loadedAt = -Infinity;
let loadFailed = false;
let loader: ((now: number) => Promise<UsageSession[]>) | null = null;
let loading: Promise<void> | null = null;
let clock: () => number = () => Date.now();
let sink: WarnSink | null = null;
let lookup: ProjectLookup = NO_PROJECTS;
let kindOf: (sessionId: string) => ChatKind = defaultKind;
const asked = new Set<string>();
let ledger: Ledger[] = [];
const listeners = new Set<() => void>();

function defaultKind(id: string): ChatKind {
  return id.startsWith("app-") ? "worker" : "chat";
}

function notify(): void {
  for (const listener of listeners) listener();
}

// ---- projects -----------------------------------------------------------------------------------------------------

const WORKTREES = "-worktrees";

/**
 * The project folder a working copy belongs to. A worktree is `<folder>-worktrees/<branch>`; any other folder is itself.
 */
export function projectFolderOfCwd(cwd: string): string {
  const text = cwd.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (cut <= 0) return text;
  const parent = text.slice(0, cut);
  const parentCut = Math.max(parent.lastIndexOf("/"), parent.lastIndexOf("\\"));
  const name = parent.slice(parentCut + 1);
  if (name.length <= WORKTREES.length || !name.endsWith(WORKTREES)) return text;
  return `${parent.slice(0, parentCut + 1)}${name.slice(0, -WORKTREES.length)}`;
}

/**
 * The key a project's limits and ceilings are stored under, and that a usage row is matched by: the hub id. A value
 * that is already a hub id stays. A folder or working copy maps to its hub id, or to its folder when it has none.
 */
export function spendKey(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (lookup.folderOf(text) !== undefined) return text;
  const folder = projectFolderOfCwd(text);
  return lookup.idOf(folder) ?? pathKey(folder);
}

/** Tests and the app register the hub's project lookup. The default knows no projects. */
export function setSpendProjectLookup(next: ProjectLookup | null): void {
  lookup = next ?? NO_PROJECTS;
}

/** The chat kind an admission reads. The default knows only workers (app- chats) and person chats. */
export function setSpendChatKind(fn: ((sessionId: string) => ChatKind) | null): void {
  kindOf = fn ?? defaultKind;
}

const automated = (kind: ChatKind): boolean => kind === "habit" || kind === "worker";

// ---- storage ------------------------------------------------------------------------------------------------------

function ceilingsFrom(raw: unknown): Record<string, TaskCeiling> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TaskCeiling> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const clean = sanitizeTaskCeiling(value);
    const project = typeof key === "string" ? spendKey(key) : "";
    if (clean && project && project !== "/") out[project] = clean;
  }
  return out;
}

/** A file that cannot be parsed is unreadable, not an empty book to overwrite. */
function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw == null) return { book: emptyBook(), ceilings: {} };
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      book: bookFromStored(value),
      ceilings: ceilingsFrom((value as { ceilings?: unknown }).ceilings),
    };
  } catch {
    return null;
  }
}

function boot(): void {
  if (booted) return;
  booted = true;
  const stored = readStored();
  if (!stored) {
    storeUnreadable = true;
    return;
  }
  storeUnreadable = false;
  book = stored.book;
  ceilings = stored.ceilings;
}

function persist(nextBook: SpendBook, nextCeilings: Record<string, TaskCeiling>): boolean {
  if (storeUnreadable) return false;
  try {
    const stored = readStored();
    if (stored == null) return false;
    if (stored.book.revision > book.revision) {
      book = stored.book;
      ceilings = stored.ceilings;
      notify();
      return false;
    }
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ revision: nextBook.revision, limits: nextBook.limits, ceilings: nextCeilings }));
    book = nextBook;
    ceilings = nextCeilings;
    notify();
    return true;
  } catch {
    return false;
  }
}

function adoptIfNewer(expected: number): boolean {
  const stored = readStored();
  if (stored && stored.book.revision !== expected) {
    book = stored.book;
    ceilings = stored.ceilings;
    notify();
    return false;
  }
  if (stored == null) return false;
  return book.revision === expected;
}

export function subscribeSpend(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes when a limit is saved or a ceiling changes, so an open task can show it. */
export function spendPulse(): string {
  boot();
  return `${book.revision}:${storeUnreadable ? "x" : "ok"}`;
}

export function spendSnapshot(): { book: SpendBook; ceilings: Record<string, TaskCeiling> } {
  boot();
  return { book, ceilings: { ...ceilings } };
}

/** True when the stored limits cannot be read. Launches hold until the person replaces them in Settings. */
export function spendUnreadable(): boolean {
  boot();
  return storeUnreadable;
}

/** The person's own choice in Settings: drop what cannot be read and start an empty book. Logged like any change. */
export function replaceUnreadableSpendStore(): boolean {
  boot();
  if (!storeUnreadable) return false;
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    return false;
  }
  storeUnreadable = false;
  book = emptyBook();
  ceilings = {};
  const wrote = persist({ revision: 1, limits: [] }, {});
  activity("spend.changed", "The unreadable spend limits were replaced with none. Set them again in Settings.", "app", "app");
  notify();
  return wrote;
}

// ---- usage rows ---------------------------------------------------------------------------------------------------

export function setSpendClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** Rows the gate reads, set directly. An app that has already read the rows uses this. */
export function setSpendSessions(next: readonly UsageSession[] | null): void {
  sessions = next == null ? null : [...next];
  loadFailed = false;
  loadedAt = clock();
  ledger = ledger.filter((entry) => entry.at > loadedAt);
}

/** The app's own reader (the usage command). Tests inject one. Rows are read again every TTL. */
export function setSpendLoader(next: ((now: number) => Promise<UsageSession[]>) | null): void {
  loader = next;
}

function refreshIfStale(): void {
  if (!loader || loading) return;
  const now = clock();
  if (sessions !== null && now - loadedAt < TTL_MS) return;
  const started = now;
  loading = loader(started)
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      sessions = rows;
      loadedAt = started;
      loadFailed = false;
      ledger = ledger.filter((entry) => entry.at > started);
      notify();
    })
    .catch(() => {
      loadFailed = true;
    })
    .finally(() => {
      loading = null;
    });
}

/** The rows as of now, or null when they cannot be trusted. */
function currentRows(): UsageSession[] | null {
  if (sessions === null) return null;
  if (loader && clock() - loadedAt >= STALE_MS) return null;
  return sessions;
}

async function ensureLoaded(): Promise<void> {
  refreshIfStale();
  const pending = loading;
  if (pending) await pending;
}

/** A turn's price, recorded once when the turn ends. Rows read after it count it through the ledger. */
function recordTurn(sessionId: string, key: string, price: TurnPrice): void {
  if (price.kind === "priced") {
    ledger.push({ key, sessionId, at: clock(), micros: Math.round(price.usd * MICRO), priced: true });
  } else if (price.kind === "unpriced") {
    ledger.push({ key, sessionId, at: clock(), micros: 0, priced: false });
  }
}

/** Turns this app has recorded since the rows were read, for one project (or all, with null) in a period. */
function ledgerInPeriod(key: string | null, period: SpendPeriod, now: number) {
  let micros = 0;
  let priced = 0;
  let unpriced = 0;
  for (const entry of ledger) {
    if (key !== null && entry.key !== key) continue;
    if (!inSpendPeriod(entry.at, now, period)) continue;
    if (entry.priced) {
      micros += entry.micros;
      priced += 1;
    } else {
      unpriced += 1;
    }
  }
  return { micros, priced, unpriced };
}

/** One limit's reading: the usage rows for its period and project, plus this app's turns since the rows were read. */
function readingFor(limit: SpendLimit, reportsCost: boolean): SpendReading {
  const key = limit.scope === "app" ? null : spendKey(limit.project);
  const now = clock();
  const base = periodSpend(currentRows(), {
    now,
    period: limit.period,
    match: key === null ? () => true : (cwd) => spendKey(cwd) === key,
    billed: isBilledModel,
  });
  if (base.unreadable) return { ...base, reportsCost };
  const extra = ledgerInPeriod(key, limit.period, now);
  return {
    measuredUsd: base.measuredUsd + extra.micros / MICRO,
    pricedTurns: base.pricedTurns + extra.priced,
    unpricedTurns: base.unpricedTurns + extra.unpriced,
    reportsCost,
  };
}

/** A run's total: every priced turn of its session in the rows, plus this app's turns since the rows were read. */
export function sessionTotal(sessionId: string): { micros: number; priced: number; unpriced: number; unreadable: boolean } {
  const rows = currentRows();
  const prices: TurnPrice[] = [];
  for (const session of rows ?? []) {
    if (!session || session.id !== sessionId) continue;
    for (const block of session.blocks ?? []) {
      if (!block || block.role !== "user" || !block.turnMetrics) continue;
      prices.push(readTurnPrice(block.turnMetrics, { billed: isBilledModel(block.turnModel?.name ?? session.model) }));
    }
  }
  const fromRows = addReportedCost(prices);
  let micros = toMicro(fromRows.measuredUsd) ?? 0;
  let priced = fromRows.pricedTurns;
  let unpriced = fromRows.unpricedTurns;
  for (const entry of ledger) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.priced) {
      micros += entry.micros;
      priced += 1;
    } else {
      unpriced += 1;
    }
  }
  return { micros, priced, unpriced, unreadable: rows === null };
}

// ---- limits -------------------------------------------------------------------------------------------------------

function limitsFor(key: string): SpendLimit[] {
  return book.limits.filter((limit) => limit.scope === "app" || spendKey(limit.project) === key);
}

function ceilingFor(key: string): TaskCeiling | null {
  boot();
  for (const [stored, value] of Object.entries(ceilings)) {
    if (spendKey(stored) === key) return value;
  }
  return null;
}

/** The limits that apply to a project: its own and the whole app's. */
export function spendFor(project: string): SpendLimit[] {
  boot();
  return limitsFor(spendKey(project));
}

export function ceilingForProject(project: string): TaskCeiling | null {
  boot();
  return ceilingFor(spendKey(project));
}

/** Who may write a limit. A chat may only lower one or set a first one; the whole app is Settings only. */
export function chatMayWrite(
  writer: SpendWriter,
  next: SpendLimit | null,
  existing: SpendLimit | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (writer === "person") return { ok: true };
  if (writer !== "first-mate") return { ok: false, reason: "Only a first mate can set a spend limit, from its own chat." };
  const scope = next?.scope ?? existing?.scope;
  if (scope === "app") return { ok: false, reason: "The whole-app spend limit is set in Settings." };
  if (next === null) return { ok: false, reason: "Clearing a spend limit needs your tap in Settings." };
  if (existing && (next.amountUsd > existing.amountUsd || next.warnAt > existing.warnAt)) {
    return { ok: false, reason: "Raising a spend limit needs your tap in Settings. A first mate can only lower it." };
  }
  return { ok: true };
}

function activity(kind: string, summary: string, project: string, target: string): void {
  if (!sink) return;
  try {
    sink.activity({ kind, summary, project, target });
  } catch {
    /* an activity line that cannot be written does not undo the change */
  }
}

function whoWrote(by: SpendWriter): string {
  return by === "person" ? "You" : "The first mate";
}

export function saveSpendLimit(
  limit: SpendLimit,
  expectedRevision: number,
  opts: { by: SpendWriter } = { by: "person" },
): { book: SpendBook; written: boolean; reason?: string } {
  boot();
  if (storeUnreadable) return { book, written: false, reason: UNREADABLE_STORE.reason };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const parsed = sanitizeSpendLimit(limit);
  if (!parsed) return { book, written: false };
  const clean = parsed.scope === "app" ? parsed : { ...parsed, project: spendKey(parsed.project) };
  const existing = book.limits.find((row) => sameLimit(row, clean));
  const allowed = chatMayWrite(opts.by, clean, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const put = putLimit(book, clean, expectedRevision);
  if (!put.written) return { book, written: false };
  const written = persist(put.book, ceilings);
  if (written) {
    const when = clean.period === "day" ? "today" : "this month";
    const target = clean.scope === "app" ? "app" : spendKey(clean.project);
    activity("spend.changed", `${whoWrote(opts.by)} set the spend limit for ${subjectOf(clean)} to ${formatUsd(clean.amountUsd)} ${when}.`, target, target);
  }
  return { book, written };
}

export function clearSpendLimit(
  scope: SpendScope,
  project: string,
  period: SpendPeriod,
  expectedRevision: number,
  opts: { by: SpendWriter } = { by: "person" },
): { book: SpendBook; written: boolean; reason?: string } {
  boot();
  if (storeUnreadable) return { book, written: false, reason: UNREADABLE_STORE.reason };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const who = scope === "app" ? "" : spendKey(project);
  const existing = book.limits.find((row) => row.scope === scope && row.project === who && row.period === period);
  if (!existing) return { book, written: false };
  const allowed = chatMayWrite(opts.by, null, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const dropped = dropLimit(book, scope, who, period, expectedRevision);
  if (!dropped.written) return { book, written: false };
  const written = persist(dropped.book, ceilings);
  if (written) {
    const label = scope === "app" ? "the whole app" : who;
    activity("spend.changed", `${whoWrote(opts.by)} cleared the spend limit for ${label}.`, who || "app", who || "app");
  }
  return { book, written };
}

/** A project's task ceiling. Person-only. The number saved is the number enforced. */
export function saveTaskCeiling(project: string, ceiling: TaskCeiling | null, expectedRevision: number): { book: SpendBook; written: boolean } {
  boot();
  if (storeUnreadable) return { book, written: false };
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const key = spendKey(project);
  if (!key || key === "/") return { book, written: false };
  let nextCeilings = ceilingsWithout(key);
  if (ceiling) {
    const clean = sanitizeTaskCeiling(ceiling);
    if (!clean) return { book, written: false };
    nextCeilings = { ...nextCeilings, [key]: clean };
  }
  const written = persist({ ...book, revision: book.revision + 1 }, nextCeilings);
  if (written) {
    const text = ceiling?.hardUsd != null ? `a task ceiling of ${formatUsd(ceiling.hardUsd)}` : "no task ceiling";
    activity("spend.changed", `You set ${text} for this project.`, key, key);
  }
  return { book, written };
}

function ceilingsWithout(key: string): Record<string, TaskCeiling> {
  const next: Record<string, TaskCeiling> = {};
  for (const [stored, value] of Object.entries(ceilings)) if (spendKey(stored) !== key) next[stored] = value;
  return next;
}

/**
 * A crew rule's task ceiling, saved by the person on the rules page. Exact: the number saved is the one enforced, a
 * higher one raises it, and null clears it.
 */
export function applyProjectRuleCeiling(project: string, usd: number | null): void {
  boot();
  const current = ceilingForProject(project);
  if (usd == null) {
    // The rules page owns the task ceiling only. A daily ceiling it never set stays.
    if (current?.hardUsd != null) {
      saveTaskCeiling(project, current.dailyUsd != null ? { dailyUsd: current.dailyUsd } : null, book.revision);
    }
    return;
  }
  const hard = sanitizeTaskCeiling({ hardUsd: usd });
  if (!hard?.hardUsd) return;
  saveTaskCeiling(
    project,
    sanitizeTaskCeiling({
      hardUsd: hard.hardUsd,
      ...(current?.softAt != null ? { softAt: current.softAt } : {}),
      ...(current?.dailyUsd != null ? { dailyUsd: current.dailyUsd } : {}),
    }),
    book.revision,
  );
}

/** Import only adds. A limit or ceiling already here is never raised. */
export function takeImportedSpend(raw: unknown): SpendBook {
  boot();
  if (storeUnreadable) return book;
  const next = importSpendLimits(book, raw);
  const incoming = raw && typeof raw === "object" && !Array.isArray(raw) ? ceilingsFrom((raw as { ceilings?: unknown }).ceilings) : {};
  let merged = { ...ceilings };
  let changed = next.revision !== book.revision || next.limits.length !== book.limits.length;
  for (const [key, value] of Object.entries(incoming)) {
    const have = merged[key];
    if (!have) {
      merged = { ...merged, [key]: value };
      changed = true;
      continue;
    }
    const kept = tighterCeiling(have, value);
    if (kept && JSON.stringify(kept) !== JSON.stringify(have)) {
      merged = { ...merged, [key]: kept };
      changed = true;
    }
  }
  if (!changed) return book;
  const storedBook = next.revision !== book.revision ? next : { ...book, revision: book.revision + 1 };
  persist(storedBook, merged);
  return book;
}

function tighterCeiling(here: TaskCeiling, incoming: TaskCeiling): TaskCeiling | null {
  const min = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.min(a, b));
  const hardUsd = min(here.hardUsd, incoming.hardUsd);
  const dailyUsd = min(here.dailyUsd, incoming.dailyUsd);
  const softAt = min(here.softAt, incoming.softAt);
  return sanitizeTaskCeiling({
    ...(hardUsd != null ? { hardUsd, ...(softAt != null ? { softAt } : {}) } : {}),
    ...(dailyUsd != null ? { dailyUsd } : {}),
  });
}

export function spendLimitsSetting(): string | null {
  boot();
  if (!book.limits.length && !Object.keys(ceilings).length) return null;
  return JSON.stringify({ revision: book.revision, limits: book.limits, ceilings });
}

// ---- verdicts -----------------------------------------------------------------------------------------------------

/**
 * The verdict a new builder reads, and the queue re-reads. Over refuses for any CLI, because a CLI that reports no cost
 * cannot be a way around a limit that is already reached.
 */
export function judgeLaunch(input: { project: string; harness: string; ownerSession?: string; warn?: boolean }): SpendVerdict {
  boot();
  if (storeUnreadable) return UNREADABLE_STORE;
  const key = spendKey(input.project);
  const limits = limitsFor(key);
  if (!limits.length) return UNSET;
  refreshIfStale();
  const reportsCost = cliReportsCost(input.harness);
  const verdicts = limits.map((limit) => ({ limit, verdict: spendAllowed(readingFor(limit, reportsCost), limit) }));
  const over = verdicts.find((row) => row.verdict.status === "over");
  if (over) return over.verdict;
  const warn = verdicts.find((row) => row.verdict.status === "warn");
  if (warn) {
    if (input.warn !== false) warnFirstMate(warn.limit, key, input.ownerSession);
    return warn.verdict;
  }
  if (!reportsCost) return UNMEASURED;
  const unmeasured = verdicts.find((row) => row.verdict.status === "unmeasured");
  return unmeasured ? unmeasured.verdict : OK;
}

function warnFirstMate(limit: SpendLimit, key: string, fallback: string | undefined): void {
  if (!sink) return;
  const owner = lookup.firstMateOf?.(key) ?? fallback ?? "";
  if (!owner) return;
  void warnOnce({
    limit,
    now: clock(),
    ownerSession: owner,
    sink,
    label: limit.scope === "app" ? "the whole app" : key,
  });
}

/** Set by the app: the wake queue and activity line. Tests inject a sink instead. */
export function setSpendWarnSink(next: WarnSink | null): void {
  sink = next;
}

/** The app's own wake queue and activity line. */
export function useLiveSpendSink(): void {
  sink = {
    wake: async (input) => {
      const mod = await import("../../firstmate/watcher/wakeQueue");
      const result = await mod.tauriWakeQueue.add(input);
      return { fresh: result?.fresh === true };
    },
    activity: (input) => {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) =>
          invoke("activity_note", {
            kind: input.kind,
            summary: input.summary,
            project: input.project,
            target: input.target,
            actorId: "",
            actorName: "",
          }),
        )
        .catch(() => undefined);
    },
  };
}

/**
 * The one admission point. Every turn passes it before it starts, whatever started it. Returns why a turn is refused.
 * A person's own chat is never refused by a limit: it is warned instead.
 */
export async function admitSpendTurn(input: {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  boot();
  const key = spendKey(input.cwd);
  const isAutomated = automated(kindOf(input.sessionId));
  const billed = isBilledModel(input.model);
  const ceiling = ceilingFor(key);
  const limits = limitsFor(key);
  if (!limits.length && !ceiling) return { ok: true };
  if (storeUnreadable) return isAutomated ? { ok: false, reason: UNREADABLE_STORE.reason } : { ok: true };
  await ensureLoaded();

  if (billed && ceiling?.hardUsd != null) {
    const task = sessionTotal(input.sessionId);
    if (task.unreadable) {
      if (isAutomated) return { ok: false, reason: "Spend for this task could not be read. The run is held until it can." };
    } else if (task.micros >= Math.round(ceiling.hardUsd * MICRO)) {
      return {
        ok: false,
        reason: `Task ceiling reached: ${formatUsd(task.micros / MICRO)} of ${formatUsd(ceiling.hardUsd)}. This run is held. Raise the task ceiling in Crew rules to continue.`,
      };
    }
  }
  if (billed && isAutomated && ceiling?.dailyUsd != null) {
    const daily = dailyReading(key);
    if (daily.unreadable) return { ok: false, reason: "Spend for today could not be read. The run is held until it can." };
    if (daily.micros >= Math.round(ceiling.dailyUsd * MICRO)) {
      return {
        ok: false,
        reason: `Daily ceiling reached: ${formatUsd(daily.micros / MICRO)} of ${formatUsd(ceiling.dailyUsd)} today. This run is held.`,
      };
    }
  }
  const reportsCost = cliReportsCost(input.harness);
  for (const limit of limits) {
    const verdict = spendAllowed(readingFor(limit, reportsCost), limit);
    if (verdict.status === "over" && isAutomated) return { ok: false, reason: verdict.reason };
    if (verdict.status === "over" || verdict.status === "warn") warnFirstMate(limit, key, input.sessionId);
  }
  return { ok: true };
}

/** A project's day total from the rows, plus this app's turns today. Unreadable only when the rows never loaded. */
function dailyReading(key: string): { micros: number; unreadable: boolean } {
  const now = clock();
  const base = periodSpend(currentRows(), { now, period: "day", match: (cwd) => spendKey(cwd) === key, billed: isBilledModel });
  const extra = ledgerInPeriod(key, "day", now);
  const micros = (toMicro(base.measuredUsd) ?? 0) + extra.micros;
  return { micros, unreadable: base.unreadable === true && loadFailed };
}

/** The ceiling line for a task row, and whether its run is held now. Derived from the rows, so a restart keeps it. */
export function taskCeilingNote(project: string, chatId?: string | null): { line: string; held: string } | null {
  boot();
  const ceiling = ceilingForProject(project);
  if (!ceiling) return null;
  const parts: string[] = [];
  if (ceiling.hardUsd != null) parts.push(`Task ceiling ${formatUsd(ceiling.hardUsd)}.`);
  if (ceiling.dailyUsd != null) parts.push(`Unattended runs stop at ${formatUsd(ceiling.dailyUsd)} today.`);
  const line = parts.join(" ").trim();
  if (!line) return null;
  let held = "";
  if (chatId && ceiling.hardUsd != null) {
    const task = sessionTotal(chatId);
    if (!task.unreadable && task.micros >= Math.round(ceiling.hardUsd * MICRO)) {
      held = `Task ceiling reached: ${formatUsd(task.micros / MICRO)} of ${formatUsd(ceiling.hardUsd)}. This run is held.`;
    }
  }
  if (!held && chatId && ceiling.dailyUsd != null && automated(kindOf(chatId))) {
    const daily = dailyReading(spendKey(project));
    if (!daily.unreadable && daily.micros >= Math.round(ceiling.dailyUsd * MICRO)) {
      held = `Daily ceiling reached: ${formatUsd(daily.micros / MICRO)} of ${formatUsd(ceiling.dailyUsd)} today. This run is held.`;
    }
  }
  return { line, held };
}

/**
 * One finished turn on a billed model. Records its price and judges the run's total for the soft ask and the hard
 * stop. A project or app limit is not judged here: it is judged at admission.
 */
export function reviewReportedTurn(input: {
  sessionId: string;
  cwd: string;
  model?: string;
  harness: string;
  metrics?: { costUsd?: number; inputTokens?: number; outputTokens?: number } | null;
  unattended?: boolean;
}): CeilingVerdict {
  const idle: CeilingVerdict = { status: "unset", reason: "", stopRun: false, ask: false };
  boot();
  if (!input.sessionId || !isBilledModel(input.model)) return idle;
  const key = spendKey(input.cwd);
  recordTurn(input.sessionId, key, readTurnPrice(input.metrics ?? undefined, { billed: true }));
  const ceiling = ceilingFor(key);
  if (!ceiling) return idle;
  refreshIfStale();
  const task = sessionTotal(input.sessionId);
  const daily = dailyReading(key);
  const verdict = ceilingDecision({
    ceiling,
    billed: true,
    reportsCost: cliReportsCost(input.harness),
    taskMeasuredUsd: task.micros / MICRO,
    taskPricedTurns: task.priced,
    taskUnpricedTurns: task.unpriced,
    dailyMeasuredUsd: daily.unreadable ? Number.NaN : daily.micros / MICRO,
    unattended: input.unattended ?? automated(kindOf(input.sessionId)),
    asked: asked.has(input.sessionId),
    continued: false,
  });
  if (verdict.ask) asked.add(input.sessionId);
  if (verdict.stopRun) notify();
  return verdict;
}

// ---- lifecycle ----------------------------------------------------------------------------------------------------

export function resetSpendGate(): void {
  booted = true;
  book = emptyBook();
  ceilings = {};
  storeUnreadable = false;
  sessions = null;
  loadedAt = -Infinity;
  loadFailed = false;
  loader = null;
  loading = null;
  clock = () => Date.now();
  sink = null;
  lookup = NO_PROJECTS;
  kindOf = defaultKind;
  asked.clear();
  ledger = [];
  resetSpendWarnings();
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* the next read still sees whatever is there */
  }
  notify();
}

/** Drop the in-memory book so the next read comes back from storage, as after a restart. Rows stay. */
export function forgetSpendMemory(): void {
  booted = false;
  book = emptyBook();
  ceilings = {};
  asked.clear();
  resetSpendWarnings();
}

/**
 * The one line a project shows. A project's own limit when it has one, otherwise the whole app's, since that one still
 * applies to this project.
 */
export function spendLine(project: string, harness: string, scope: SpendScope = "project"): string {
  boot();
  const key = spendKey(project);
  const own = book.limits.find((row) => row.scope === scope && (scope === "app" || spendKey(row.project) === key));
  const limit = own ?? (scope === "project" ? book.limits.find((row) => row.scope === "app") : undefined);
  if (!limit) return "No spend limit is set.";
  const reading = readingFor(limit, cliReportsCost(harness));
  if (reading.unreadable) return spendAllowed(reading, limit).reason;
  return spendStatusLine(reading, limit);
}

