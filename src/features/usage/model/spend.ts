import { dayKey, type UsageSession } from "./history";
import { readTurnPrice } from "./cliCost";
import { formatUsd, MAX_USD, MICRO, toMicro } from "./money";

/**
 * WP-176. A dollar limit for one project or the whole app, for a local day or a calendar month.
 * Nothing here is a bill. The figure is measured cost, and a missing price is never stored as $0.
 * No limit is set until the person sets one.
 */

export const SPEND_LIMITS_KEY = "monocode.spendLimits.v1";

export const DEFAULT_WARN_AT = 0.8;
const WARN_MIN = 0.5;
const WARN_MAX = 1;

export type SpendScope = "project" | "app";
export type SpendPeriod = "day" | "month";

export type SpendLimit = {
  scope: SpendScope;
  /** Empty for the whole app. Otherwise the project key (its hub id). */
  project: string;
  period: SpendPeriod;
  amountUsd: number;
  warnAt: number;
};

export type SpendBook = {
  revision: number;
  limits: SpendLimit[];
};

export type SpendReading = {
  measuredUsd: number;
  pricedTurns: number;
  unpricedTurns: number;
  /** Whether the CLI that is about to run reports a cost at all. Set by the caller, never by the total. */
  reportsCost: boolean;
  /** The usage rows could not be read. Not a final failure: the next check tries again. */
  unreadable?: boolean;
  /** Some of the measured spend was reported by Claude Code: its figure is its price table's estimate (round 5). */
  claudeMeasured?: boolean;
};

/** The label on a dollar figure whose cost Claude Code reported (keyed on the spend's source, round 5). */
export function estimateNote(reading: { claudeMeasured?: boolean } | null | undefined): string {
  return reading?.claudeMeasured === true ? " Estimated from Claude Code's price table." : "";
}

export type SpendStatus = "ok" | "warn" | "over" | "unmeasured" | "unset";

export type SpendVerdict = {
  status: SpendStatus;
  reason: string;
};

const UNSET: SpendVerdict = { status: "unset", reason: "" };
const OK: SpendVerdict = { status: "ok", reason: "" };

export function emptyBook(): SpendBook {
  return { revision: 0, limits: [] };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").replace(/[\r\n\0]/g, "").trim();
  if (!text || text.length > 4096) return null;
  return text;
}

/** A stored or typed limit is untrusted. A broken one is dropped, not thrown. */
export function sanitizeSpendLimit(raw: unknown): SpendLimit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.scope !== "project" && row.scope !== "app") return null;
  if (row.period !== "day" && row.period !== "month") return null;
  const amount = finite(row.amountUsd);
  const amountMicro = amount === undefined ? undefined : toMicro(amount);
  if (amount === undefined || amount <= 0 || amountMicro === undefined || amount > MAX_USD) return null;
  const warn = row.warnAt === undefined ? DEFAULT_WARN_AT : finite(row.warnAt);
  if (warn === undefined || warn < WARN_MIN || warn > WARN_MAX) return null;
  const project = row.scope === "app" ? "" : cleanProject(row.project);
  if (project === null) return null;
  return { scope: row.scope, project, period: row.period, amountUsd: amountMicro / MICRO, warnAt: warn };
}

export function sameLimit(a: Pick<SpendLimit, "scope" | "project" | "period">, b: Pick<SpendLimit, "scope" | "project" | "period">): boolean {
  return a.scope === b.scope && a.project === b.project && a.period === b.period;
}

function sorted(limits: SpendLimit[]): SpendLimit[] {
  return [...limits].sort((a, b) => `${a.scope}\0${a.project}\0${a.period}`.localeCompare(`${b.scope}\0${b.project}\0${b.period}`));
}

/** Compare-and-swap. A stale revision writes nothing and returns the book unchanged. */
export function putLimit(book: SpendBook, limit: SpendLimit, expectedRevision: number): { book: SpendBook; written: boolean } {
  if (!book || book.revision !== expectedRevision) return { book, written: false };
  const clean = sanitizeSpendLimit(limit);
  if (!clean) return { book, written: false };
  const next = book.limits.filter((row) => !sameLimit(row, clean));
  next.push(clean);
  return { book: { revision: book.revision + 1, limits: sorted(next) }, written: true };
}

export function dropLimit(
  book: SpendBook,
  scope: SpendScope,
  project: string,
  period: SpendPeriod,
  expectedRevision: number,
): { book: SpendBook; written: boolean } {
  if (!book || book.revision !== expectedRevision) return { book, written: false };
  const target = { scope, project: scope === "app" ? "" : project, period };
  const next = book.limits.filter((row) => !sameLimit(row, target));
  if (next.length === book.limits.length) return { book, written: false };
  return { book: { revision: book.revision + 1, limits: next }, written: true };
}

export function bookFromStored(raw: unknown): SpendBook {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return emptyBook();
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyBook();
  const row = value as Record<string, unknown>;
  const revision = finite(row.revision);
  const limits = Array.isArray(row.limits) ? row.limits.map(sanitizeSpendLimit).filter((item): item is SpendLimit => item != null) : [];
  return {
    revision: revision !== undefined && revision >= 0 && Number.isInteger(revision) ? revision : 0,
    limits: sorted(limits),
  };
}

/**
 * Import only adds. A cap that is already here is never raised, even when the file asks to replace settings.
 * A lower cap is kept, because a smaller ceiling is the cautious one.
 */
export function importSpendLimits(here: SpendBook, incoming: unknown): SpendBook {
  const file = bookFromStored(incoming);
  let book = here ?? emptyBook();
  for (const limit of file.limits) {
    const existing = book.limits.find((row) => sameLimit(row, limit));
    if (!existing) {
      const put = putLimit(book, limit, book.revision);
      if (put.written) book = put.book;
      continue;
    }
    if (limit.amountUsd > existing.amountUsd) continue;
    if (limit.amountUsd === existing.amountUsd && limit.warnAt >= existing.warnAt) continue;
    const put = putLimit(
      book,
      { ...existing, amountUsd: Math.min(existing.amountUsd, limit.amountUsd), warnAt: Math.min(existing.warnAt, limit.warnAt) },
      book.revision,
    );
    if (put.written) book = put.book;
  }
  return book;
}

export const formatMeasuredUsd = formatUsd;

function periodWords(period: SpendPeriod): { spent: string; reset: string } {
  return period === "day" ? { spent: "today", reset: "the day" } : { spent: "this month", reset: "the month" };
}

/** The subject a reason names: the project's key, or the whole app. */
export function subjectOf(limit: Pick<SpendLimit, "scope" | "project">): string {
  return limit.scope === "app" ? "the whole app" : limit.project;
}

/**
 * One limit against one reading. Over and warn are judged from the measured total first. A reading that has turns
 * with no price says so, and never reads as a clean total.
 */
export function spendAllowed(spent: SpendReading | null | undefined, limit: SpendLimit | null | undefined): SpendVerdict {
  if (!limit) return UNSET;
  const clean = sanitizeSpendLimit(limit);
  if (!clean) return UNSET;
  if (!spent || spent.unreadable || !Number.isFinite(spent.measuredUsd) || spent.measuredUsd < 0) {
    return {
      status: "over",
      reason: `Spend for ${subjectOf(clean)} could not be read. New builders wait until it can.`,
    };
  }
  const measured = toMicro(spent.measuredUsd) ?? 0;
  const cap = toMicro(clean.amountUsd) ?? 0;
  const warnAt = toMicro(clean.amountUsd * clean.warnAt) ?? cap;
  const words = periodWords(clean.period);
  if (measured >= cap) {
    return {
      status: "over",
      reason: `Spend limit reached for ${subjectOf(clean)}: ${formatUsd(spent.measuredUsd)} of ${formatUsd(clean.amountUsd)} ${words.spent}. Raise it, or wait for ${words.reset} to reset.${estimateNote(spent)}`,
    };
  }
  if (measured >= warnAt) {
    return {
      status: "warn",
      reason: `Measured cost for ${subjectOf(clean)} is ${formatUsd(spent.measuredUsd)} of ${formatUsd(clean.amountUsd)} ${words.spent}.${estimateNote(spent)}`,
    };
  }
  if (!spent.reportsCost) {
    return { status: "unmeasured", reason: "This CLI reports no cost, so this limit cannot count its work." };
  }
  if (spent.unpricedTurns > 0) {
    const turns = spent.unpricedTurns === 1 ? "1 turn" : `${spent.unpricedTurns} turns`;
    return {
      status: "unmeasured",
      reason: `Measured cost for ${subjectOf(clean)} is ${formatUsd(spent.measuredUsd)} of ${formatUsd(clean.amountUsd)} ${words.spent}. ${turns} reported no cost, so they are not counted.`,
    };
  }
  return OK;
}

export function spendStatusLine(spent: SpendReading, limit: SpendLimit): string {
  const verdict = spendAllowed(spent, limit);
  if (verdict.status === "unmeasured") return verdict.reason;
  if (verdict.status === "unset") return "";
  const clean = sanitizeSpendLimit(limit);
  if (!clean) return "";
  const words = periodWords(clean.period);
  const cap = toMicro(clean.amountUsd) ?? 0;
  const measured = toMicro(spent.measuredUsd) ?? 0;
  const percent = cap > 0 ? Math.round((measured / cap) * 100) : 0;
  return `Spent ${formatUsd(spent.measuredUsd)} of ${formatUsd(clean.amountUsd)} ${words.spent} (${percent}%). New builders pause at ${formatUsd(clean.amountUsd)}.${estimateNote(spent)}`;
}

export function periodId(period: SpendPeriod, now: number): string {
  const day = dayKey(now);
  if (!day) return "";
  return period === "day" ? day : day.slice(0, 7);
}

export function inPeriod(at: number, now: number, period: SpendPeriod): boolean {
  const day = dayKey(at);
  const today = dayKey(now);
  if (!day || !today) return false;
  return period === "day" ? day === today : day.slice(0, 7) === today.slice(0, 7);
}

export function warnKey(limit: SpendLimit, now: number): string {
  const who = limit.scope === "app" ? "app" : limit.project;
  return `spend-warn:${limit.scope}:${who}:${periodId(limit.period, now)}`;
}

export type WarnSink = {
  wake(input: { ownerSession: string; kind: string; key: string; text: string }): Promise<{ fresh: boolean }>;
  activity(input: { kind: string; summary: string; project: string; target: string }): void;
};

const warned = new Set<string>();

/** Tests start from a period that has not warned yet. */
export function resetSpendWarnings(): void {
  warned.clear();
}

/** One wake and one activity line per limit per period. A failed send is not remembered. */
export async function warnOnce(input: {
  limit: SpendLimit;
  now: number;
  ownerSession: string;
  sink: WarnSink;
  label: string;
  /** The measured cost is Claude Code's price table's estimate, so the activity line says so. */
  estimated?: boolean;
}): Promise<boolean> {
  const key = warnKey(input.limit, input.now);
  if (!key || warned.has(key)) return false;
  const text = `Measured cost for ${input.label} has crossed the warning share (${periodId(input.limit.period, input.now)}).`;
  try {
    const result = await input.sink.wake({ ownerSession: input.ownerSession, kind: "spend.warn", key, text });
    if (!result?.fresh) {
      warned.add(key);
      return false;
    }
    input.sink.activity({
      kind: "spend.warn",
      summary: input.estimated ? `${text} Estimated from Claude Code's price table.` : text,
      project: input.limit.scope === "app" ? "app" : input.limit.project,
      target: key,
    });
    warned.add(key);
    return true;
  } catch {
    return false;
  }
}

/** One project's spend on one session and one local day: what the ledger stores and the gate reads. */
export type SpendDay = {
  /** The project key the turn was written under: a hub id, or a folder when the project has none. */
  projectKey: string;
  sessionId: string;
  /** Local day, YYYY-MM-DD. */
  day: string;
  micros: number;
  priced: number;
  unpriced: number;
  /** The CLI that reported the cost ("claude" for Claude Code). Unset for a row written before it was kept. */
  source?: string;
};

const dayIn = (day: string, today: string, period: SpendPeriod): boolean =>
  period === "day" ? day === today : day.slice(0, 7) === today.slice(0, 7);

/** The period total from day records. `match` says whether a record's project key is the limit's project. */
export function sumDays(
  records: readonly SpendDay[] | null | undefined,
  opts: { now: number; period: SpendPeriod; match: (projectKey: string) => boolean },
): Omit<SpendReading, "reportsCost"> {
  const today = dayKey(opts.now);
  if (records == null || !today) return { measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, unreadable: true };
  let micros = 0;
  let priced = 0;
  let unpriced = 0;
  let claudeMeasured = false;
  for (const row of records) {
    if (!row || !opts.match(row.projectKey) || !dayIn(row.day, today, opts.period)) continue;
    micros += row.micros;
    priced += row.priced;
    unpriced += row.unpriced;
    if (row.source === "claude" && row.priced > 0) claudeMeasured = true;
  }
  return { measuredUsd: micros / MICRO, pricedTurns: priced, unpricedTurns: unpriced, claudeMeasured };
}

/**
 * Day records from saved chat rows. Used by tests and by any reader that starts from chats. A turn with no price is
 * counted apart; a $0 from a billed model is unpriced (see readTurnPrice).
 */
export function daysFromSessions(
  sessions: readonly UsageSession[] | null | undefined,
  billed: (model: string | undefined) => boolean,
): SpendDay[] | null {
  if (sessions == null) return null;
  const out: SpendDay[] = [];
  const seenSessions = new Set<string>();
  const seenBlocks = new Set<string>();
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const sessionId = typeof session.id === "string" ? session.id : "";
    if (sessionId && seenSessions.has(sessionId)) continue;
    if (sessionId) seenSessions.add(sessionId);
    const projectKey = typeof session.cwd === "string" ? session.cwd : "";
    for (const block of session.blocks ?? []) {
      if (!block || block.role !== "user" || !block.turnMetrics) continue;
      const blockId = typeof block.id === "string" ? block.id : "";
      if (sessionId && blockId) {
        const blockKey = `${sessionId}\u0000${blockId}`;
        if (seenBlocks.has(blockKey)) continue;
        seenBlocks.add(blockKey);
      }
      const stamp = typeof block.startedAt === "number" ? block.startedAt : typeof block.sentAt === "number" ? block.sentAt : undefined;
      if (stamp == null || !Number.isFinite(stamp)) continue;
      const day = dayKey(stamp);
      if (!day) continue;
      const model = block.turnModel?.name ?? session.model;
      const price = readTurnPrice(block.turnMetrics, { billed: billed(model) });
      if (price.kind === "empty") continue;
      const micros = price.kind === "priced" ? (toMicro(price.usd) ?? 0) : 0;
      out.push({
        projectKey,
        sessionId,
        day,
        micros,
        priced: price.kind === "priced" ? 1 : 0,
        unpriced: price.kind === "priced" ? 0 : 1,
        source: typeof session.harness === "string" ? session.harness.trim().toLowerCase() : undefined,
      });
    }
  }
  return out;
}
