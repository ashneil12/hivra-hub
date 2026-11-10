import { pathKey } from "../../../shared/lib/paths";
import { dayKey, type UsageSession } from "./history";
import { addReportedCost, readTurnPrice } from "./cliCost";

/**
 * WP-176. A dollar limit for one project or the whole app, for a local day or a calendar month.
 * Nothing here is a bill. The figure is measured cost, and a missing price is never stored as $0.
 * No limit is set until the person sets one.
 */

export const SPEND_LIMITS_KEY = "monocode.spendLimits.v1";

export const DEFAULT_WARN_AT = 0.8;
const WARN_MIN = 0.5;
const WARN_MAX = 1;
const MAX_AMOUNT_USD = 1_000_000_000;
const MICRO = 1_000_000;

export type SpendScope = "project" | "app";
export type SpendPeriod = "day" | "month";

export type SpendLimit = {
  scope: SpendScope;
  /** Empty for the whole app. Otherwise the project id or folder the person named. */
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
  reportsCost: boolean;
  /** The usage rows could not be read. Not a final failure: the next check tries again. */
  unreadable?: boolean;
};

export type SpendStatus = "ok" | "warn" | "over" | "unmeasured" | "unset";

export type SpendVerdict = {
  status: SpendStatus;
  reason: string;
};

export type SpendBand = {
  id: "task" | "daily" | "project" | "app";
  label: string;
  period: SpendPeriod;
  amountUsd: number;
  warnAt: number;
  reading: SpendReading;
  /** True only for the per-task hard cap. A project or app limit never stops a running builder. */
  stopsRun: boolean;
};

const UNSET: SpendVerdict = { status: "unset", reason: "" };
const OK: SpendVerdict = { status: "ok", reason: "" };

export function emptyBook(): SpendBook {
  return { revision: 0, limits: [] };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function micro(usd: number): number | undefined {
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  const scaled = Math.round(usd * MICRO);
  return Number.isSafeInteger(scaled) ? scaled : undefined;
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
  const amountMicro = amount === undefined ? undefined : micro(amount);
  if (amount === undefined || amount <= 0 || amountMicro === undefined || amount > MAX_AMOUNT_USD) return null;
  const warn = row.warnAt === undefined ? DEFAULT_WARN_AT : finite(row.warnAt);
  if (warn === undefined || warn < WARN_MIN || warn > WARN_MAX) return null;
  const project = row.scope === "app" ? "" : cleanProject(row.project);
  if (project === null) return null;
  return { scope: row.scope, project, period: row.period, amountUsd: amountMicro / MICRO, warnAt: warn };
}

function sameLimit(a: Pick<SpendLimit, "scope" | "project" | "period">, b: Pick<SpendLimit, "scope" | "project" | "period">): boolean {
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

export function formatMeasuredUsd(usd: number): string {
  const cents = micro(usd);
  if (cents === undefined) return "";
  const whole = Math.round(cents / 10_000);
  if (whole % 100 === 0) return `$${whole / 100}`;
  return `$${(whole / 100).toFixed(2)}`;
}

function subject(limit: SpendLimit): string {
  return limit.scope === "app" ? "the whole app" : limit.project;
}

function periodWords(period: SpendPeriod): { spent: string; reset: string } {
  return period === "day" ? { spent: "today", reset: "the day" } : { spent: "this month", reset: "the month" };
}

/** Whole dollars without cents, otherwise two decimals. */
export function spendAllowed(spent: SpendReading | null | undefined, limit: SpendLimit | null | undefined): SpendVerdict {
  if (!limit) return UNSET;
  const clean = sanitizeSpendLimit(limit);
  if (!clean) return UNSET;
  if (!spent || spent.unreadable || !Number.isFinite(spent.measuredUsd) || spent.measuredUsd < 0) {
    return {
      status: "over",
      reason: `Spend for ${subject(clean)} could not be read. New builders wait until it can.`,
    };
  }
  if (!spent.reportsCost || (spent.pricedTurns === 0 && spent.unpricedTurns > 0)) {
    return { status: "unmeasured", reason: "This CLI reports no cost, so this limit cannot count its work." };
  }
  const measured = micro(spent.measuredUsd) ?? 0;
  const cap = micro(clean.amountUsd) ?? 0;
  const warnAt = micro(clean.amountUsd * clean.warnAt) ?? cap;
  const words = periodWords(clean.period);
  if (measured >= cap) {
    return {
      status: "over",
      reason: `Spend limit reached for ${subject(clean)}: ${formatMeasuredUsd(spent.measuredUsd)} of ${formatMeasuredUsd(clean.amountUsd)} ${words.spent}. Raise it, or wait for ${words.reset} to reset.`,
    };
  }
  if (measured >= warnAt) {
    return {
      status: "warn",
      reason: `Measured cost for ${subject(clean)} is ${formatMeasuredUsd(spent.measuredUsd)} of ${formatMeasuredUsd(clean.amountUsd)} ${words.spent}.`,
    };
  }
  // Priced turns under the cap still leave some work uncounted. Say so, never pass it as a clean total.
  if (spent.unpricedTurns > 0) {
    const turns = spent.unpricedTurns === 1 ? "1 turn" : `${spent.unpricedTurns} turns`;
    return {
      status: "unmeasured",
      reason: `Measured cost for ${subject(clean)} is ${formatMeasuredUsd(spent.measuredUsd)} of ${formatMeasuredUsd(clean.amountUsd)} ${words.spent}. ${turns} reported no cost, so they are not counted.`,
    };
  }
  return OK;
}

export function spendStatusLine(spent: SpendReading, limit: SpendLimit, _label?: string): string {
  const verdict = spendAllowed(spent, limit);
  if (verdict.status === "unmeasured") return verdict.reason;
  if (verdict.status === "unset") return "";
  const clean = sanitizeSpendLimit(limit);
  if (!clean) return "";
  const words = periodWords(clean.period);
  const cap = micro(clean.amountUsd) ?? 0;
  const measured = micro(spent.measuredUsd) ?? 0;
  const percent = cap > 0 ? Math.round((measured / cap) * 100) : 0;
  return `Spent ${formatMeasuredUsd(spent.measuredUsd)} of ${formatMeasuredUsd(clean.amountUsd)} ${words.spent} (${percent}%). New builders pause at ${formatMeasuredUsd(clean.amountUsd)}.`;
}

export function periodId(period: SpendPeriod, now: number): string {
  const day = dayKey(now);
  if (!day) return "";
  return period === "day" ? day : day.slice(0, 7);
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
}): Promise<boolean> {
  const key = warnKey(input.limit, input.now);
  if (!key || warned.has(key)) return false;
  const text = `Measured cost for ${input.label} has crossed the warning share (${periodId(input.limit.period, input.now)}).`;
  try {
    const result = await input.sink.wake({
      ownerSession: input.ownerSession,
      kind: "spend.warn",
      key,
      text,
    });
    if (!result?.fresh) {
      warned.add(key);
      return false;
    }
    input.sink.activity({
      kind: "spend.warn",
      summary: text,
      project: input.limit.scope === "app" ? "app" : input.limit.project,
      target: key,
    });
    warned.add(key);
    return true;
  } catch {
    return false;
  }
}

/** A project id matches its folder, and a folder matches itself. `want` is already a path key. */
function projectMatches(cwd: string, want: string): boolean {
  if (!want) return false;
  const have = pathKey(cwd);
  if (have === want) return true;
  const base = have.split("/").filter(Boolean).pop() ?? "";
  const wantBase = want.split("/").filter(Boolean).pop() ?? "";
  return base.length > 0 && (base === want || base === wantBase);
}

function inPeriod(at: number, now: number, period: SpendPeriod): boolean {
  const day = dayKey(at);
  const today = dayKey(now);
  if (!day || !today) return false;
  return period === "day" ? day === today : day.slice(0, 7) === today.slice(0, 7);
}

/**
 * The period total, summed from usage rows. There is no counter to reset.
 * Empty session ids are not folded together, so two unnamed chats are both counted.
 */
export function periodSpend(
  sessions: readonly UsageSession[] | null | undefined,
  opts: { now: number; period: SpendPeriod; scope: SpendScope; project?: string },
): SpendReading {
  if (sessions == null || !Number.isFinite(opts.now)) {
    return { measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, reportsCost: true, unreadable: true };
  }
  const want = opts.scope === "project" ? pathKey(opts.project ?? "") : "";
  const seenSessions = new Set<string>();
  const seenBlocks = new Set<string>();
  const prices: ReturnType<typeof readTurnPrice>[] = [];
  for (const session of sessions ?? []) {
    if (!session || typeof session !== "object") continue;
    const sessionId = typeof session.id === "string" ? session.id : "";
    if (sessionId && seenSessions.has(sessionId)) continue;
    if (sessionId) seenSessions.add(sessionId);
    const cwd = typeof session.cwd === "string" ? session.cwd : "";
    if (opts.scope === "project" && !projectMatches(cwd, want)) continue;
    let index = 0;
    for (const block of session.blocks ?? []) {
      index += 1;
      if (!block || block.role !== "user" || !block.turnMetrics) continue;
      const blockId = typeof block.id === "string" ? block.id : "";
      if (sessionId && blockId) {
        const blockKey = `${sessionId}\u0000${blockId}`;
        if (seenBlocks.has(blockKey)) continue;
        seenBlocks.add(blockKey);
      }
      const stamp = typeof block.startedAt === "number" ? block.startedAt : typeof block.sentAt === "number" ? block.sentAt : undefined;
      if (stamp == null || !Number.isFinite(stamp)) continue;
      const at = Math.min(stamp, opts.now);
      if (!inPeriod(at, opts.now, opts.period)) continue;
      prices.push(readTurnPrice(block.turnMetrics));
    }
  }
  const total = addReportedCost(prices);
  return { ...total, reportsCost: true };
}

function headroom(band: SpendBand): number {
  if (band.reading.unreadable || !Number.isFinite(band.reading.measuredUsd) || band.reading.measuredUsd < 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const cap = micro(band.amountUsd);
  const spent = micro(band.reading.measuredUsd);
  if (cap === undefined || spent === undefined) return Number.NEGATIVE_INFINITY;
  return cap - spent;
}

const BAND_RANK: Record<SpendBand["id"], number> = { task: 0, daily: 1, project: 2, app: 3 };

/** The band with the least room left is checked first. A tie keeps the narrower one. */
export function strictest(bands: readonly SpendBand[]): { band?: SpendBand; verdict: SpendVerdict } {
  const on = bands.filter((band) => sanitizeSpendLimit({
    scope: band.id === "app" ? "app" : "project",
    project: band.id === "app" ? "" : band.label || "limit",
    period: band.period,
    amountUsd: band.amountUsd,
    warnAt: band.warnAt,
  }));
  if (!on.length) return { verdict: UNSET };
  const ranked = [...on].sort((a, b) => headroom(a) - headroom(b) || BAND_RANK[a.id] - BAND_RANK[b.id]);
  const judged = ranked.map((band) => ({
    band,
    verdict: spendAllowed(band.reading, {
      scope: band.id === "app" ? "app" : "project",
      project: band.id === "app" ? "" : band.label,
      period: band.period,
      amountUsd: band.amountUsd,
      warnAt: band.warnAt,
    }),
  }));
  return (
    judged.find((row) => row.verdict.status === "over") ??
    judged.find((row) => row.verdict.status === "warn") ??
    judged.find((row) => row.verdict.status === "unmeasured") ??
    judged.find((row) => row.verdict.status === "ok") ?? { verdict: UNSET }
  );
}
