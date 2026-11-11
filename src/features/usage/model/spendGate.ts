/**
 * WP-176. The stored limits, the spend ledger, and the verdicts the launch and turn gates read.
 *
 * Spend comes from the app's ledger (src-tauri/src/spend_ledger.rs): one record per turn, written when the turn ends,
 * with its project and whether its price was reported. Chat delete and trash never touch it. The gate reads day totals
 * from the ledger every few seconds and adds this app's own turns that are not yet saved.
 *
 * One admission point (`admitSpendTurn`) judges every turn before it starts. A turn is a person's only when the
 * composer sent it (origin "person"). Anything else is automated, including turns of unknown origin: a limit refuses
 * those and warns a person's chat. A per-task ceiling on a billed model refuses any further turn of that run once its
 * total is past the cap.
 *
 * Limits are keyed by the project's hub id. A folder, a worktree or a pool slot maps to its project through git, so a
 * limit saved by name, by folder or from Settings is the same limit.
 */

import { pathKey } from "../../../shared/lib/paths";
import { isBilledModel } from "../../sessions/model/customModels";
import { cliReportsCost, readTurnPrice } from "./cliCost";
import { dayKey, type UsageSession } from "./history";
import { formatUsd, MICRO, toMicro } from "./money";
import {
  bookFromStored,
  daysFromSessions,
  dropLimit,
  emptyBook,
  importSpendLimits,
  resetSpendWarnings,
  sanitizeSpendLimit,
  spendAllowed,
  spendStatusLine,
  subjectOf,
  sumDays,
  warnOnce,
  type SpendBook,
  type SpendDay,
  type SpendLimit,
  type SpendPeriod,
  type SpendReading,
  type SpendScope,
  type SpendVerdict,
  type WarnSink,
} from "./spend";
import { ceilingDecision, sanitizeTaskCeiling, type CeilingVerdict, type TaskCeiling } from "./taskCeiling";

export type { SpendVerdict } from "./spend";

export const LOCAL_KEY = "monocode:spend-limits";
/** Records are read again after this long. A check in between uses what it has. */
const TTL_MS = 5_000;
/** Records older than this are not trusted: a check reports unreadable instead of an old total. */
const STALE_MS = 10 * 60_000;

export const RAISE_LIMIT = "Raise limit";

export type SpendWriter = "person" | "first-mate" | "habit" | "worker" | "checker";
/** Who started a turn. Only the composer is a person; everything else is automated. */
export type TurnOrigin = "person" | "automated";

export type SpendSinkEvent = { kind: string; summary: string; project: string };

/** A turn this app has measured, kept until the ledger has it. */
type Pending = { record: SpendDay; at: number; savedAt?: number };
type Stored = { book: SpendBook; ceilings: Record<string, TaskCeiling> };
export type ProjectLookup = {
  /** The hub id of the project a folder belongs to. */
  idOf(folder: string): string | undefined;
  /** The folder of a hub project id. */
  folderOf(id: string): string | undefined;
  /** The project's first mate chat, which hears a warning. */
  firstMateOf?(key: string): string | undefined;
  /** The project a chat belongs to, when the chat itself says (a habit run runs from home, for example). */
  projectOfSession?(sessionId: string): string | undefined;
  /** The main checkout a working copy belongs to, from git. */
  resolveFolder?(cwd: string): Promise<string>;
};
/** The ledger's writer. The app sets it; without one, turns stay in memory. */
export type SpendPersist = (entry: { sessionId: string; projectKey: string; at: number; micros: number; priced: boolean }) => Promise<void>;
/** The ledger's reader: day totals from `since` on. The app sets it; tests set records directly. */
export type SpendLoader = (since: number) => Promise<SpendDay[]>;

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
/** The ledger's day records, or null until one read has landed. */
let records: SpendDay[] | null = null;
let loadedAt = -Infinity;
let loader: SpendLoader | null = null;
let loading: Promise<void> | null = null;
let persist: SpendPersist | null = null;
let clock: () => number = () => Date.now();
let sink: WarnSink | null = null;
let lookup: ProjectLookup = NO_PROJECTS;
const folders = new Map<string, string>();
const asked = new Set<string>();
let pending: Pending[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// ---- projects -----------------------------------------------------------------------------------------------------

const WORKTREES = "-worktrees";

/**
 * A heuristic for a working copy's folder, used only until git has answered: `<folder>-worktrees/<branch>` is the
 * folder. Any other folder is itself.
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

function folderOfCwdCached(cwd: string): string {
  return folders.get(cwd.trim()) ?? projectFolderOfCwd(cwd);
}

/** The key a project's limits and ceilings are stored under: the hub id. A folder maps to it; a hub id stays. */
export function spendKey(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (lookup.folderOf(text) !== undefined) return text;
  const folder = folderOfCwdCached(text);
  return lookup.idOf(folder) ?? pathKey(folder);
}

async function folderOfCwd(cwd: string): Promise<string> {
  const text = cwd.trim();
  const known = folders.get(text);
  if (known !== undefined) return known;
  if (lookup.resolveFolder) {
    try {
      const folder = await lookup.resolveFolder(text);
      if (folder) {
        folders.set(text, folder);
        return folder;
      }
    } catch {
      /* git did not answer: the heuristic stands, and the next check asks again */
    }
  }
  return projectFolderOfCwd(text);
}

/** Starts git's answer for a working copy without waiting for it. The next check uses it. */
function askFolder(cwd: string): void {
  const text = cwd.trim();
  if (!lookup.resolveFolder || !text || folders.has(text)) return;
  void folderOfCwd(text);
}

/** The project a turn belongs to, for a check that may wait for git. */
async function keyForTurn(sessionId: string, cwd: string): Promise<string> {
  const own = lookup.projectOfSession?.(sessionId);
  if (own) return spendKey(own);
  return spendKey(await folderOfCwd(cwd));
}

/** The same key without waiting. Asks git for the answer, so the next call has it. */
function keyForTurnNow(sessionId: string, cwd: string): string {
  const own = lookup.projectOfSession?.(sessionId);
  if (own) return spendKey(own);
  askFolder(cwd);
  return spendKey(folderOfCwdCached(cwd));
}

/** Tests and the app register the hub's project lookup. The default knows no projects. */
export function setSpendProjectLookup(next: ProjectLookup | null): void {
  lookup = next ?? NO_PROJECTS;
  folders.clear();
}

const automated = (origin: TurnOrigin | undefined): boolean => origin !== "person";

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
  let raw: string | null;
  try {
    // No storage at all (a runtime without localStorage) holds no limits; that is not the same as a stored file that
    // cannot be read, which holds launches.
    if (typeof localStorage === "undefined") return { book: emptyBook(), ceilings: {} };
    raw = localStorage.getItem(LOCAL_KEY);
  } catch {
    return { book: emptyBook(), ceilings: {} };
  }
  try {
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

function persistStored(nextBook: SpendBook, nextCeilings: Record<string, TaskCeiling>): boolean {
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
  const wrote = persistStored({ revision: 1, limits: [] }, {});
  activity("spend.changed", "The unreadable spend limits were replaced with none. Set them again in Settings.", "app", "app");
  notify();
  return wrote;
}

/** Another window saved the limits. Read them again on the next check. */
export function refreshSpendFromStorage(): void {
  booted = false;
  book = emptyBook();
  ceilings = {};
  resetSpendWarnings();
  notify();
}

// ---- the ledger ---------------------------------------------------------------------------------------------------

export function setSpendClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

/** The ledger's day records, set directly. Tests use this; the app's loader sets them every TTL. */
export function setSpendRecords(next: readonly SpendDay[] | null): void {
  records = next == null ? null : [...next];
  loadedAt = clock();
}

/** Chat rows as day records, for tests that start from chats. */
export function setSpendSessions(next: readonly UsageSession[] | null): void {
  setSpendRecords(daysFromSessions(next, isBilledModel));
}

/** The app's reader of the ledger. The app sets it at start (spendWiring.ts). */
export function setSpendLoader(next: SpendLoader | null): void {
  loader = next;
}

/** The app's writer of a turn to the ledger. Without one, turns stay in memory. */
export function setSpendPersist(next: SpendPersist | null): void {
  persist = next;
}

function startOfMonth(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function refreshIfStale(): void {
  if (!loader || loading) return;
  const now = clock();
  if (records !== null && now - loadedAt < TTL_MS) return;
  const started = now;
  loading = loader(startOfMonth(now))
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      records = rows;
      loadedAt = started;
      // A turn saved before this read began is in the rows now.
      pending = pending.filter((row) => row.savedAt === undefined || row.savedAt > started);
      notify();
    })
    .catch(() => {
      /* a failed read keeps the last one; the staleness limit still applies */
    })
    .finally(() => {
      loading = null;
    });
  for (const row of pending) if (row.savedAt === undefined) saveTurn(row);
}

/** The day records as of now, or null when they cannot be trusted. Includes turns this app has not saved yet. */
function currentRecords(): SpendDay[] | null {
  if (records === null) return null;
  if (loader && clock() - loadedAt >= STALE_MS) return null;
  return [...records, ...pending.map((row) => row.record)];
}

async function ensureLoaded(): Promise<void> {
  refreshIfStale();
  const wait = loading;
  if (wait) await wait;
}

function saveTurn(row: Pending): void {
  if (!persist) return;
  const { record } = row;
  persist({
    sessionId: record.sessionId,
    projectKey: record.projectKey,
    at: row.at,
    micros: record.micros,
    priced: record.priced === 1,
  })
    .then(() => {
      row.savedAt = clock();
    })
    .catch(() => {
      /* kept in memory and tried again on the next read */
    });
}

/** A turn's price, written once when the turn ends. Counted at once; saved to the ledger in the background. */
function recordTurn(sessionId: string, projectKey: string, price: ReturnType<typeof readTurnPrice>): void {
  if (price.kind === "empty") return;
  const at = clock();
  const day = dayKey(at);
  if (!day) return;
  const micros = price.kind === "priced" ? (toMicro(price.usd) ?? 0) : 0;
  const row: Pending = {
    record: {
      projectKey,
      sessionId,
      day,
      micros,
      priced: price.kind === "priced" ? 1 : 0,
      unpriced: price.kind === "priced" ? 0 : 1,
    },
    at,
  };
  pending.push(row);
  saveTurn(row);
}

/** One limit's reading: the ledger for its period and project. */
function readingFor(limit: SpendLimit, reportsCost: boolean): SpendReading {
  const key = limit.scope === "app" ? null : spendKey(limit.project);
  const base = sumDays(currentRecords(), {
    now: clock(),
    period: limit.period,
    match: key === null ? () => true : (projectKey) => spendKey(projectKey) === key,
  });
  return { ...base, reportsCost };
}

/** A run's total across all days, from the ledger. */
export function sessionTotal(sessionId: string): { micros: number; priced: number; unpriced: number; unreadable: boolean } {
  const rows = currentRecords();
  if (rows === null) return { micros: 0, priced: 0, unpriced: 0, unreadable: true };
  let micros = 0;
  let priced = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (row.sessionId !== sessionId) continue;
    micros += row.micros;
    priced += row.priced;
    unpriced += row.unpriced;
  }
  return { micros, priced, unpriced, unreadable: false };
}

// ---- limits -------------------------------------------------------------------------------------------------------

function limitsFor(key: string): SpendLimit[] {
  return book.limits.filter((limit) => limit.scope === "app" || spendKey(limit.project) === key);
}

/** The stored limit for a project and period, matched by its key, so a folder and a hub id are one limit. */
function findLimit(scope: SpendScope, key: string, period: SpendPeriod): SpendLimit | undefined {
  return book.limits.find((row) => row.scope === scope && row.period === period && (scope === "app" || spendKey(row.project) === key));
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

/** Who may write a limit. A first mate may only set a first limit or lower one; the whole app is Settings only. */
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
  const existing = findLimit(clean.scope, clean.project, clean.period);
  const allowed = chatMayWrite(opts.by, clean, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const kept = book.limits.filter(
    (row) => !(row.scope === clean.scope && row.period === clean.period && (clean.scope === "app" || spendKey(row.project) === clean.project)),
  );
  const nextBook = { revision: book.revision + 1, limits: [...kept, clean] };
  const written = persistStored(nextBook, ceilings);
  if (written) {
    const when = clean.period === "day" ? "today" : "this month";
    const target = clean.scope === "app" ? "app" : clean.project;
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
  const key = scope === "app" ? "" : spendKey(project);
  const existing = findLimit(scope, key, period);
  if (!existing) return { book, written: false };
  const allowed = chatMayWrite(opts.by, null, existing);
  if (!allowed.ok) return { book, written: false, reason: allowed.reason };
  const dropped = dropLimit(book, scope, existing.project, period, expectedRevision);
  if (!dropped.written) return { book, written: false };
  const written = persistStored(dropped.book, ceilings);
  if (written) {
    const label = scope === "app" ? "the whole app" : key;
    activity("spend.changed", `${whoWrote(opts.by)} cleared the spend limit for ${label}.`, scope === "app" ? "app" : key, scope === "app" ? "app" : key);
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
  const written = persistStored({ ...book, revision: book.revision + 1 }, nextCeilings);
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

/** Import only adds. A limit or ceiling already here is never raised. Logged when anything was added. */
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
  if (persistStored(storedBook, merged)) {
    activity("spend.changed", "Spend limits were imported. Limits already set were not raised.", "app", "app");
  }
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
 * cannot be a way around a limit that is already reached. Reads only: it sends no warning.
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

/** True when a limit or a ceiling is set, or the stored limits cannot be read: only then does a turn need admission. */
export function spendGateActive(): boolean {
  boot();
  return storeUnreadable || book.limits.length > 0 || Object.keys(ceilings).length > 0;
}

/**
 * The one admission point. Every turn passes it before it starts. Returns why a turn is refused. A person's own
 * composer turn is never refused by a limit: it is warned instead. An automated turn over a limit, or past its
 * run's ceiling, is refused. Unreadable storage refuses every automated turn.
 */
export async function admitSpendTurn(input: {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
  origin?: TurnOrigin;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  boot();
  const isAutomated = automated(input.origin);
  // Nothing set, nothing stored that cannot be read: the common case answers without waiting, so a turn starts as it did.
  if (!storeUnreadable && !book.limits.length && !Object.keys(ceilings).length) return { ok: true };
  if (storeUnreadable) return isAutomated ? { ok: false, reason: UNREADABLE_STORE.reason } : { ok: true };
  const key = await keyForTurn(input.sessionId, input.cwd);
  const billed = isBilledModel(input.model);
  const ceiling = ceilingFor(key);
  const limits = limitsFor(key);
  if (!limits.length && !ceiling) return { ok: true };
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

/** A project's day total from the ledger. Unreadable when the ledger has never been read. */
function dailyReading(key: string): { micros: number; unreadable: boolean } {
  const base = sumDays(currentRecords(), { now: clock(), period: "day", match: (projectKey) => spendKey(projectKey) === key });
  return { micros: toMicro(base.measuredUsd) ?? 0, unreadable: base.unreadable === true };
}

/** The ceiling line for a task row, and whether its run is held now. Derived from the ledger, so a restart keeps it. */
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
  if (!held && chatId && ceiling.dailyUsd != null) {
    const daily = dailyReading(spendKey(project));
    if (!daily.unreadable && daily.micros >= Math.round(ceiling.dailyUsd * MICRO)) {
      held = `Daily ceiling reached: ${formatUsd(daily.micros / MICRO)} of ${formatUsd(ceiling.dailyUsd)} today. This run is held.`;
    }
  }
  return { line, held };
}

/**
 * One finished turn. Records its price in the ledger, whatever the model, and judges the run's total for the soft ask
 * and the hard stop. A project or app limit is not judged here: it is judged at admission.
 */
export function reviewReportedTurn(input: {
  sessionId: string;
  cwd: string;
  model?: string;
  harness: string;
  metrics?: { costUsd?: number; inputTokens?: number; outputTokens?: number } | null;
  /** Omitted means automated: a turn of unknown origin is treated as automated. */
  origin?: TurnOrigin;
}): CeilingVerdict {
  const idle: CeilingVerdict = { status: "unset", reason: "", stopRun: false, ask: false };
  boot();
  if (!input.sessionId) return idle;
  const billed = isBilledModel(input.model);
  const key = keyForTurnNow(input.sessionId, input.cwd);
  recordTurn(input.sessionId, key, readTurnPrice(input.metrics ?? undefined, { billed }));
  if (!billed) return idle;
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
    unattended: automated(input.origin),
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
  records = null;
  loadedAt = -Infinity;
  loader = null;
  loading = null;
  persist = null;
  clock = () => Date.now();
  sink = null;
  lookup = NO_PROJECTS;
  folders.clear();
  asked.clear();
  pending = [];
  resetSpendWarnings();
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* the next read still sees whatever is there */
  }
  notify();
}

/** Drop the in-memory book so the next read comes back from storage, as after a restart. The ledger stays. */
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
  const key = scope === "app" ? "" : spendKey(project);
  const own = findLimit(scope, key, "month") ?? findLimit(scope, key, "day");
  const limit = own ?? (scope === "project" ? book.limits.find((row) => row.scope === "app") : undefined);
  if (!limit) return "No spend limit is set.";
  const reading = readingFor(limit, cliReportsCost(harness));
  if (reading.unreadable) return spendAllowed(reading, limit).reason;
  return spendStatusLine(reading, limit);
}
