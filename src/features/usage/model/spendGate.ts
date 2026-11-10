/**
 * WP-176. The stored limits, the cached usage rows, and the verdict a new builder reads.
 * A project or app limit never stops a running builder. The per-task ceiling is judged
 * at the end of a billed turn, from the cost that CLI reported.
 */

import { pathKey } from "../../../shared/lib/paths";
import { isBilledModel } from "../../sessions/model/customModels";
import { cliReportsCost, readTurnPrice } from "./cliCost";
import { dayKey, type UsageSession } from "./history";
import {
  bookFromStored,
  dropLimit,
  emptyBook,
  importSpendLimits,
  formatMeasuredUsd,
  periodSpend,
  putLimit,
  resetSpendWarnings,
  spendAllowed,
  spendStatusLine,
  strictest,
  warnOnce,
  type SpendBook,
  type SpendLimit,
  type SpendPeriod,
  type SpendScope,
  type SpendVerdict,
  type WarnSink,
} from "./spend";
import {
  ceilingDecision,
  sanitizeTaskCeiling,
  type CeilingVerdict,
  type TaskCeiling,
} from "./taskCeiling";

const LOCAL_KEY = "monocode:spend-limits";
const MICRO = 1_000_000;

const UNSET: SpendVerdict = { status: "unset", reason: "" };
const UNMEASURED: SpendVerdict = {
  status: "unmeasured",
  reason: "This CLI reports no cost, so this limit cannot count its work.",
};

export const RAISE_LIMIT = "Raise limit";

type Run = {
  micros: number;
  priced: number;
  unpriced: number;
  asked: boolean;
  continued: boolean;
};

type Ledger = { day: string; micros: number };

type Stored = { book: SpendBook; ceilings: Record<string, TaskCeiling> };

let booted = false;
let book: SpendBook = emptyBook();
let ceilings: Record<string, TaskCeiling> = {};
let sessions: readonly UsageSession[] | null = null;
let sessionsSet = false;
let clock: () => number = () => Date.now();
let sink: WarnSink | null = null;
let refresh: Promise<void> | null = null;
const runs = new Map<string, Run>();
const ledger: Ledger[] = [];
const holds = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function namesProject(stored: string, asked: string): boolean {
  if (!stored || !asked) return false;
  const have = pathKey(stored);
  const want = pathKey(asked);
  if (!have || !want || have === "/" || want === "/") return false;
  if (have === want) return true;
  const base = have.split("/").filter(Boolean).pop() ?? "";
  const wantBase = want.split("/").filter(Boolean).pop() ?? "";
  return base.length > 0 && (base === want || base === wantBase);
}

function ceilingsFrom(raw: unknown): Record<string, TaskCeiling> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TaskCeiling> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const clean = sanitizeTaskCeiling(value);
    const project = typeof key === "string" ? pathKey(key) : "";
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
  if (!stored) return;
  book = stored.book;
  ceilings = stored.ceilings;
}

function persist(nextBook: SpendBook, nextCeilings: Record<string, TaskCeiling>): boolean {
  try {
    const stored = readStored();
    if (stored && stored.book.revision > book.revision) {
      book = stored.book;
      ceilings = stored.ceilings;
      notify();
      return false;
    }
    if (stored == null) return false;
    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({ revision: nextBook.revision, limits: nextBook.limits, ceilings: nextCeilings }),
    );
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
  if (book.revision !== expected) return false;
  return true;
}

export function subscribeSpend(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes when a limit is saved or a run is held, so an open task can show it. */
export function spendPulse(): string {
  boot();
  return `${book.revision}:${holds.size}`;
}

export function spendSnapshot(): { book: SpendBook; ceilings: Record<string, TaskCeiling> } {
  boot();
  return { book, ceilings: { ...ceilings } };
}

export function setSpendClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function setSpendSessions(next: readonly UsageSession[] | null): void {
  sessions = next;
  sessionsSet = true;
  ledger.length = 0;
}

export function setSpendWarnSink(next: WarnSink | null): void {
  sink = next;
}

/** The app's own wake queue and activity line. Tests inject a sink instead. */
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

export function resetSpendGate(): void {
  booted = true;
  book = emptyBook();
  ceilings = {};
  sessions = null;
  sessionsSet = false;
  clock = () => Date.now();
  sink = null;
  refresh = null;
  runs.clear();
  ledger.length = 0;
  holds.clear();
  resetSpendWarnings();
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* the next read still sees whatever is there */
  }
  notify();
}

/** Drop the in-memory book so the next read comes back from storage. Rows stay. */
export function forgetSpendMemory(): void {
  booted = false;
  book = emptyBook();
  ceilings = {};
  runs.clear();
  ledger.length = 0;
  holds.clear();
  resetSpendWarnings();
}

function ensureSessions(): void {
  if (sessionsSet || refresh) return;
  const now = clock();
  refresh = import("./load")
    .then((mod) => mod.loadUsageSessions(now))
    .then((rows) => {
      if (sessionsSet || !Array.isArray(rows)) return;
      sessions = rows;
      sessionsSet = true;
      notify();
    })
    .catch(() => {
      /* a timeout is not a final failure; the next check tries again */
    })
    .finally(() => {
      refresh = null;
    });
}

function limitsFor(project: string): SpendLimit[] {
  return book.limits.filter((limit) => limit.scope === "app" || namesProject(limit.project, project));
}

function readingFor(limit: SpendLimit, project: string) {
  const rows = sessionsSet ? sessions : null;
  const reading = periodSpend(rows, {
    now: clock(),
    period: limit.period,
    scope: limit.scope,
    ...(limit.scope === "project" ? { project } : {}),
  });
  return { ...reading, reportsCost: true };
}

export function judgeLaunch(input: { project: string; harness: string; ownerSession?: string }): SpendVerdict {
  boot();
  const limits = limitsFor(input.project);
  if (!limits.length) return UNSET;
  if (!cliReportsCost(input.harness)) return UNMEASURED;
  if (!sessionsSet) ensureSessions();
  const bands = limits.map((limit) => ({
    id: limit.scope === "app" ? ("app" as const) : ("project" as const),
    label: limit.scope === "app" ? "the whole app" : limit.project,
    period: limit.period,
    amountUsd: limit.amountUsd,
    warnAt: limit.warnAt,
    reading: readingFor(limit, input.project),
    stopsRun: false,
  }));
  const ranked = strictest(bands);
  const owner = input.ownerSession?.trim() ?? "";
  if (owner && sink) {
    for (const limit of limits) {
      const verdict = spendAllowed(readingFor(limit, input.project), limit);
      if (verdict.status !== "warn" && verdict.status !== "over") continue;
      void warnOnce({
        limit,
        now: clock(),
        ownerSession: owner,
        sink,
        label: limit.scope === "app" ? "the whole app" : limit.project,
      });
    }
  }
  return ranked.verdict;
}

export function saveSpendLimit(limit: SpendLimit, expectedRevision: number): { book: SpendBook; written: boolean } {
  boot();
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const put = putLimit(book, limit, expectedRevision);
  if (!put.written) return { book, written: false };
  const written = persist(put.book, ceilings);
  return { book, written };
}

export function clearSpendLimit(
  scope: SpendScope,
  project: string,
  period: SpendPeriod,
  expectedRevision: number,
): { book: SpendBook; written: boolean } {
  boot();
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const dropped = dropLimit(book, scope, project, period, expectedRevision);
  if (!dropped.written) return { book, written: false };
  const written = persist(dropped.book, ceilings);
  return { book, written };
}

export function saveTaskCeiling(
  project: string,
  ceiling: TaskCeiling | null,
  expectedRevision: number,
): { book: SpendBook; written: boolean } {
  boot();
  if (!adoptIfNewer(expectedRevision)) return { book, written: false };
  const key = pathKey(project);
  if (!key || key === "/") return { book, written: false };
  if (ceiling) {
    const clean = sanitizeTaskCeiling(ceiling);
    if (!clean) return { book, written: false };
    ceilings = { ...ceilings, [key]: clean };
  } else {
    const next = { ...ceilings };
    delete next[key];
    ceilings = next;
  }
  const written = persist({ ...book, revision: book.revision + 1 }, ceilings);
  return { book, written };
}

export function spendLimitsSetting(): string | null {
  boot();
  if (!book.limits.length && !Object.keys(ceilings).length) return null;
  return JSON.stringify({ revision: book.revision, limits: book.limits, ceilings });
}

function tighterCeiling(here: TaskCeiling, incoming: TaskCeiling): TaskCeiling | null {
  const hardValues = [here.hardUsd, incoming.hardUsd].filter((value): value is number => value != null);
  const dailyValues = [here.dailyUsd, incoming.dailyUsd].filter((value): value is number => value != null);
  const softValues = [here.softAt, incoming.softAt].filter((value): value is number => value != null);
  const hardUsd = hardValues.length ? Math.min(...hardValues) : undefined;
  const dailyUsd = dailyValues.length ? Math.min(...dailyValues) : undefined;
  const softAt = softValues.length ? Math.min(...softValues) : undefined;
  return sanitizeTaskCeiling({
    ...(hardUsd != null ? { hardUsd, ...(softAt != null ? { softAt } : {}) } : {}),
    ...(dailyUsd != null ? { dailyUsd } : {}),
  });
}

/** Import only adds. A ceiling already here is never raised. */
export function takeImportedSpend(raw: unknown): SpendBook {
  boot();
  const next = importSpendLimits(book, raw);
  let merged = { ...ceilings };
  const incoming = raw && typeof raw === "object" && !Array.isArray(raw) ? ceilingsFrom((raw as { ceilings?: unknown }).ceilings) : {};
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

/** The project limits that name this project, plus any app limit. Empty when nothing is set. */
export function spendFor(project: string): SpendLimit[] {
  boot();
  return limitsFor(project);
}

export function spendLine(project: string, harness: string, scope: SpendScope = "project"): string {
  boot();
  const limit = book.limits.find((row) => row.scope === scope && (scope === "app" || namesProject(row.project, project)));
  if (!limit) return "No spend limit is set.";
  if (!cliReportsCost(harness)) return UNMEASURED.reason;
  const reading = readingFor(limit, project);
  if (reading.unreadable) return spendAllowed(reading, limit).reason;
  return spendStatusLine({ ...reading, reportsCost: true }, limit);
}

export function ceilingForProject(project: string): TaskCeiling | null {
  boot();
  for (const [key, value] of Object.entries(ceilings)) {
    if (namesProject(key, project)) return value;
  }
  return null;
}

/**
 * The lowest ceiling on a project's crew rules. Null does nothing, so a rule
 * with no ceiling cannot clear one the person set. A higher number cannot raise it.
 */
export function applyProjectRuleCeiling(project: string, usd: number | null): void {
  boot();
  if (usd == null) return;
  const incoming = sanitizeTaskCeiling({ hardUsd: usd });
  if (!incoming?.hardUsd) return;
  const have = ceilingForProject(project);
  if (have?.hardUsd != null && have.hardUsd <= incoming.hardUsd) return;
  const next = sanitizeTaskCeiling({
    hardUsd: incoming.hardUsd,
    ...(have?.softAt != null ? { softAt: have.softAt } : {}),
    ...(have?.dailyUsd != null ? { dailyUsd: have.dailyUsd } : {}),
  });
  if (!next) return;
  saveTaskCeiling(project, next, book.revision);
}

export function ceilingHold(sessionId: string): string | undefined {
  return holds.get(sessionId);
}

/** The ceiling line for a task row. Empty held means the run has not been stopped. */
export function taskCeilingNote(project: string, chatId?: string | null): { line: string; held: string } | null {
  boot();
  const ceiling = ceilingForProject(project);
  if (!ceiling) return null;
  const parts: string[] = [];
  if (ceiling.hardUsd != null) parts.push(`Task ceiling ${formatMeasuredUsd(ceiling.hardUsd)}.`);
  if (ceiling.dailyUsd != null) parts.push(`Unattended runs stop at ${formatMeasuredUsd(ceiling.dailyUsd)} today.`);
  const line = parts.join(" ").trim();
  if (!line) return null;
  const held = chatId ? (holds.get(chatId) ?? "") : "";
  return { line, held };
}

export function continueTask(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run) return;
  run.continued = true;
  holds.delete(sessionId);
}

/**
 * One finished turn on a billed model. The figure is the CLI's own cost for this
 * turn, added once. A project or app limit is not applied here.
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
  const ceiling = ceilingForProject(input.cwd);
  if (!ceiling) return idle;
  const price = readTurnPrice(input.metrics ?? undefined);
  const run = runs.get(input.sessionId) ?? { micros: 0, priced: 0, unpriced: 0, asked: false, continued: false };
  if (price.kind === "priced") {
    const micros = Math.round(price.usd * MICRO);
    if (Number.isSafeInteger(run.micros + micros)) run.micros += micros;
    run.priced += 1;
    const day = dayKey(clock());
    if (day) ledger.push({ day, micros });
  } else if (price.kind === "unpriced") {
    run.unpriced += 1;
  }
  runs.set(input.sessionId, run);
  const now = clock();
  const dayReading = periodSpend(sessionsSet ? sessions : null, {
    now,
    period: "day",
    scope: "project",
    project: input.cwd,
  });
  const day = dayKey(now);
  const extra = day ? ledger.filter((row) => row.day === day).reduce((sum, row) => sum + row.micros, 0) / MICRO : 0;
  const dailyUnreadable = ceiling.dailyUsd != null && input.unattended === true && (!sessionsSet || sessions == null || dayReading.unreadable === true);
  const verdict = ceilingDecision({
    ceiling,
    billed: true,
    reportsCost: cliReportsCost(input.harness),
    taskMeasuredUsd: run.micros / MICRO,
    taskPricedTurns: run.priced,
    taskUnpricedTurns: run.unpriced,
    dailyMeasuredUsd: dailyUnreadable ? Number.NaN : dayReading.measuredUsd + extra,
    unattended: input.unattended === true,
    asked: run.asked,
    continued: run.continued,
  });
  if (verdict.ask) run.asked = true;
  if (verdict.stopRun && verdict.reason.trim()) {
    holds.set(input.sessionId, verdict.reason.trim());
    notify();
  }
  return verdict;
}
