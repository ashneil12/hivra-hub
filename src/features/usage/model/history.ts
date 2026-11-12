import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { pathKey, prettyCwd, projectName } from "../../../shared/lib/paths";
import { estimateTurn, type TurnTokens } from "./rates";

/**
 * WP-108: what a chat's turns spent, per day, project, engine and model.
 *
 * The input is the turn metrics Hivra already saves on each user block (`TurnMetrics` in
 * `features/sessions/model/session.ts`), read through a narrow shape so this stays a pure model: no store, no
 * window, no clock of its own. A turn is counted on the day it was sent, so a chat that runs past midnight splits
 * across both days.
 *
 * Nothing here is estimated. A price is shown only when the CLI reported one; a turn with tokens and no price is
 * counted as such, and the screen says so. Only counts and names are kept: the history never carries a prompt or a
 * reply, and a project is named by its folder, never by its full path.
 */

/** The token and price fields of one turn, as the CLI reported them. */
export type UsageTurnMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

/** One block of a saved chat, narrowed to what the history reads. */
export type UsageBlock = {
  id?: string;
  role?: string;
  /** Epoch ms when the user turn started. */
  startedAt?: number;
  /** Epoch ms when this message joined a turn already running. */
  sentAt?: number;
  turnModel?: { harness?: string; name?: string };
  turnMetrics?: UsageTurnMetrics;
};

/** One saved chat, narrowed to what the history reads. */
export type UsageSession = {
  id: string;
  cwd: string;
  harness: string;
  model: string;
  blocks: UsageBlock[];
};

export type UsageTotals = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Turns whose engine reported a price. */
  costTurns: number;
  /** Turns whose counts are known but whose engine reported no price. */
  unpricedTurns: number;
  /**
   * WP-253: turns whose engine reported no price, at API list prices. Fills the gap beside `costUsd`; it never
   * re-prices a turn that has a reported cost. An estimate, never a bill; spend limits never read it.
   */
  estimatedUsd: number;
  /** Turns with no reported price whose model has a listed one, so they are in `estimatedUsd`. */
  estimatedTurns: number;
  /** WP-253: what cache reads saved against full input price, at list prices. */
  cacheSavedUsd: number;
};

export type UsageDay = {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  totals: UsageTotals;
};

export type UsageGroup = {
  /** Stable key: the project label, the engine id or the model id. */
  key: string;
  label: string;
  totals: UsageTotals;
};

export type UsageHistory = {
  /** Every day in the window, oldest first, with an empty day filled in. */
  days: UsageDay[];
  today: UsageTotals;
  last7: UsageTotals;
  last30: UsageTotals;
  byProject: UsageGroup[];
  byEngine: UsageGroup[];
  byModel: UsageGroup[];
  /** The window the days cover, in days. */
  windowDays: number;
};

export const DEFAULT_WINDOW_DAYS = 30;

export function emptyTotals(): UsageTotals {
  return {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costTurns: 0,
    unpricedTurns: 0,
    estimatedUsd: 0,
    estimatedTurns: 0,
    cacheSavedUsd: 0,
  };
}

/** A count or price worth adding: a finite, non-negative number. Anything else is left out, never counted as zero. */
function usable(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Add one count to a running total without leaving the safe integer range. A value past the range (a broken file, a
 * provider bug) is too large to be real, so it stops counting there rather than turning the total into Infinity.
 */
function add(total: number, value: number | undefined): number {
  if (value == null || value === 0) return total;
  const next = total + value;
  if (!Number.isFinite(next)) return Number.MAX_SAFE_INTEGER;
  return Math.min(next, Number.MAX_SAFE_INTEGER);
}

/** Midnight local time for a day key, or `undefined` when the key is not a day. */
function dayStart(key: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

/** The reader's own calendar day for an epoch ms stamp, `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `6 Nov` for a day key, and nothing for one it cannot read. */
export function dayLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month}` : "";
}

/**
 * Every day in the window, oldest first: `[from, today]`. Stepping calendar days rather than 86,400,000 ms keeps a
 * daylight-saving change from shifting or dropping a day.
 */
function windowDays(now: number, days: number): string[] {
  const today = dayStart(dayKey(now));
  if (today == null) return [];
  const keys: string[] = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let index = 0; index < days; index += 1) {
    keys.push(dayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function emptyHistory(days: string[]): UsageHistory {
  return {
    days: days.map((day) => ({ day, totals: emptyTotals() })),
    today: emptyTotals(),
    last7: emptyTotals(),
    last30: emptyTotals(),
    byProject: [],
    byEngine: [],
    byModel: [],
    windowDays: days.length,
  };
}

function clampDays(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_WINDOW_DAYS;
  }
  return Math.min(Math.floor(value), 366);
}

function turnTotals(metrics: UsageTurnMetrics, model?: string): UsageTotals {
  const inputTokens = usable(metrics.inputTokens);
  const outputTokens = usable(metrics.outputTokens);
  const cacheReadTokens = usable(metrics.cacheReadTokens);
  const cacheWriteTokens = usable(metrics.cacheWriteTokens);
  const costUsd = usable(metrics.costUsd);
  const hasCounts =
    inputTokens != null ||
    outputTokens != null ||
    cacheReadTokens != null ||
    cacheWriteTokens != null;
  return {
    turns: 1,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    costUsd: costUsd ?? 0,
    costTurns: costUsd != null ? 1 : 0,
    unpricedTurns: costUsd == null && hasCounts ? 1 : 0,
    ...estimateTotals(model, hasCounts, costUsd != null, {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: cacheReadTokens ?? 0,
      cacheWriteTokens: cacheWriteTokens ?? 0,
    }),
  };
}

function estimateTotals(
  model: string | undefined,
  hasCounts: boolean,
  priced: boolean,
  tokens: TurnTokens,
): Pick<UsageTotals, "estimatedUsd" | "estimatedTurns" | "cacheSavedUsd"> {
  const estimate = hasCounts ? estimateTurn(model, tokens) : undefined;
  if (!estimate) return { estimatedUsd: 0, estimatedTurns: 0, cacheSavedUsd: 0 };
  if (priced) return { estimatedUsd: 0, estimatedTurns: 0, cacheSavedUsd: estimate.cacheSavedUsd };
  return { estimatedUsd: estimate.estimatedUsd, estimatedTurns: 1, cacheSavedUsd: estimate.cacheSavedUsd };
}

function engineLabel(id: string): string {
  const name = HARNESS_TITLE[id as HarnessId];
  return name ?? (id.trim() || "Unknown engine");
}

/** The folder a project is named by, with `~` for home and "No project" for a chat that named none. */
function projectLabel(cwd: string): string {
  const path = typeof cwd === "string" ? cwd.trim() : "";
  if (!path) return "No project";
  if (prettyCwd(path) === "~") return "Home";
  return projectName(path) || "No project";
}

/** A project, named by its folder, with the key that stands for it in the result. */
type ProjectRef = { key: string; label: string };

/**
 * A name per project path. Two checkouts whose folders carry the same name (`a/app`, `b/app`) get one more folder
 * of path each, and so on until the names differ, so a row is never a guess about which project it is. The name is
 * all that leaves this model: a full path is never part of a key, a row or the CSV, so the unique name serves as the
 * key too.
 */
function projectRefs(sessions: readonly UsageSession[]): Map<string, ProjectRef> {
  const paths = new Map<string, string>();
  for (const session of sessions) {
    const path = typeof session?.cwd === "string" ? session.cwd.trim() : "";
    const key = path ? pathKey(path) : "";
    if (!paths.has(key)) paths.set(key, path);
  }
  const segmentsOf = (path: string): string[] =>
    path ? path.replace(/\\/g, "/").split("/").filter(Boolean) : [];

  const refs = new Map<string, ProjectRef>();
  const depthOf = new Map<string, number>();
  for (const [key, path] of paths) {
    depthOf.set(key, 1);
    refs.set(key, { key: projectLabel(path), label: projectLabel(path) });
  }
  // Escalate one folder at a time until every project's name is its own. A finite number of rounds: each round
  // gives at least one more path folder to at least one clashing project, and path folders run out.
  for (let round = 0; round < 64; round += 1) {
    const owners = new Map<string, string[]>();
    for (const [key, ref] of refs) {
      owners.set(ref.key, [...(owners.get(ref.key) ?? []), key]);
    }
    const clashes = [...owners.values()].filter((keys) => keys.length > 1);
    if (clashes.length === 0) break;
    let moved = false;
    for (const keys of clashes) {
      for (const key of keys) {
        const path = paths.get(key) ?? "";
        const parts = segmentsOf(path);
        // "No project" and "Home" are not folder names, so they are never widened into a path.
        const special = !path || prettyCwd(path) === "~";
        if (special) continue;
        const depth = (depthOf.get(key) ?? 1) + 1;
        if (depth > parts.length) continue;
        const candidate = parts.slice(-depth).join("/");
        if (candidate !== refs.get(key)!.key) {
          refs.set(key, { key: candidate, label: candidate });
          depthOf.set(key, depth);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return refs;
}

function addTotals(target: UsageTotals, turn: UsageTotals): void {
  target.turns = add(target.turns, turn.turns);
  target.inputTokens = add(target.inputTokens, turn.inputTokens);
  target.outputTokens = add(target.outputTokens, turn.outputTokens);
  target.cacheReadTokens = add(target.cacheReadTokens, turn.cacheReadTokens);
  target.cacheWriteTokens = add(target.cacheWriteTokens, turn.cacheWriteTokens);
  target.costUsd = add(target.costUsd, turn.costUsd);
  target.costTurns = add(target.costTurns, turn.costTurns);
  target.unpricedTurns = add(target.unpricedTurns, turn.unpricedTurns);
  target.estimatedUsd = add(target.estimatedUsd, turn.estimatedUsd);
  target.estimatedTurns = add(target.estimatedTurns, turn.estimatedTurns);
  target.cacheSavedUsd = add(target.cacheSavedUsd, turn.cacheSavedUsd);
}

/** A group's label, kept beside its totals so the result carries both. */
type GroupBucket = { label: string; totals: UsageTotals };

function bucket(
  groups: Map<string, GroupBucket>,
  key: string,
  label: string,
): UsageTotals {
  let entry = groups.get(key);
  if (!entry) {
    entry = { label, totals: emptyTotals() };
    groups.set(key, entry);
  }
  return entry.totals;
}

/** Largest by tokens, then by name, so a tie is stable. */
function ranked(groups: Map<string, GroupBucket>): UsageGroup[] {
  return [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      const weightA = a.totals.inputTokens + a.totals.outputTokens;
      const weightB = b.totals.inputTokens + b.totals.outputTokens;
      return (
        weightB - weightA || a.label.localeCompare(b.label) || keyA.localeCompare(keyB)
      );
    })
    .map(([key, { label, totals }]) => ({ key, label, totals }));
}

/**
 * Read every saved turn into per-day, per-project, per-engine and per-model totals for the last `days` days (30 by
 * default). A chat or a block offered twice is counted once. Unreadable values are dropped, not zeroed.
 */
export function buildUsageHistory(
  sessions: readonly UsageSession[],
  options: { now: number; days?: number },
): UsageHistory {
  const days = clampDays(options.days);
  const now = options.now;
  if (!Number.isFinite(now)) {
    // No readable clock means no day names to draw, but the page still gets its empty window rather than no bars.
    // The day keys are empty on purpose so nothing is dated; they only fill the bar row and read as blank labels.
    return emptyHistory(Array.from({ length: days }, () => ""));
  }
  const keys = windowDays(now, days);
  if (keys.length === 0) return emptyHistory([]);
  const firstStart = dayStart(keys[0])!;
  const slotOf = new Map<string, number>();
  keys.forEach((key, index) => slotOf.set(key, index));

  const history = emptyHistory(keys);
  const projects = new Map<string, GroupBucket>();
  const engines = new Map<string, GroupBucket>();
  const models = new Map<string, GroupBucket>();

  const seenSessions = new Set<string>();
  const seenBlocks = new Set<string>();
  const refs = projectRefs(sessions);

  for (const session of sessions) {
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (seenSessions.has(sessionId)) continue;
    seenSessions.add(sessionId);
    const cwd = typeof session?.cwd === "string" ? session.cwd.trim() : "";
    const project = refs.get(cwd ? pathKey(cwd) : "") ?? {
      key: "No project",
      label: "No project",
    };
    const sessionEngine =
      typeof session.harness === "string" ? session.harness.trim() : "";
    const sessionModel =
      typeof session.model === "string" ? session.model.trim() : "";
    let index = 0;
    for (const block of session.blocks ?? []) {
      index += 1;
      if (!block || block.role !== "user" || !block.turnMetrics) continue;
      const blockId =
        typeof block.id === "string" && block.id ? block.id : `${index}`;
      const blockKey = `${sessionId}\u0000${blockId}`;
      if (seenBlocks.has(blockKey)) continue;
      seenBlocks.add(blockKey);

      const stamp =
        typeof block.startedAt === "number"
          ? block.startedAt
          : typeof block.sentAt === "number"
            ? block.sentAt
            : undefined;
      if (stamp == null || !Number.isFinite(stamp)) continue;
      // A stamp in the future (a clock that moved) belongs to today, so it never lands past the window.
      // The day name, not a fixed 24 hours, decides the slot: the last day of a daylight-saving change can last 25
      // hours, and a turn in that extra hour is still today.
      const at = Math.min(stamp, now);
      if (at < firstStart) continue;
      const slot = slotOf.get(dayKey(at));
      if (slot == null) continue;

      const turnModel = block.turnModel;
      const engine =
        (typeof turnModel?.harness === "string" && turnModel.harness.trim()) ||
        sessionEngine;
      const model =
        (typeof turnModel?.name === "string" && turnModel.name.trim()) ||
        sessionModel;
      const totals = turnTotals(block.turnMetrics, model);
      if (totals.unpricedTurns === 0 && totals.costTurns === 0 && totals.turns === 0) {
        // No counts and no price: nothing was reported, so there is nothing to count.
        continue;
      }
      const anyCount =
        usable(block.turnMetrics.inputTokens) != null ||
        usable(block.turnMetrics.outputTokens) != null ||
        usable(block.turnMetrics.cacheReadTokens) != null ||
        usable(block.turnMetrics.cacheWriteTokens) != null ||
        usable(block.turnMetrics.costUsd) != null;
      if (!anyCount) continue;

      addTotals(history.days[slot].totals, totals);
      addTotals(bucket(projects, project.key, project.label), totals);
      const engineId = engine || "unknown";
      addTotals(bucket(engines, engineId, engineLabel(engineId)), totals);
      const modelId = model || "Unknown model";
      addTotals(bucket(models, modelId, model || "Unknown model"), totals);
    }
  }

  const sumDays = (count: number): UsageTotals => {
    const total = emptyTotals();
    for (const day of history.days.slice(Math.max(0, history.days.length - count))) {
      addTotals(total, day.totals);
    }
    return total;
  };

  return {
    ...history,
    today: sumDays(1),
    last7: sumDays(7),
    last30: sumDays(30),
    byProject: ranked(projects),
    byEngine: ranked(engines),
    byModel: ranked(models),
  };
}

/** One plain sentence about where the cost figures came from. */
export function costNote(totals: UsageTotals): string {
  if (totals.turns === 0) return "No turns yet";
  if (totals.costTurns === 0) return "Cost not reported by this engine";
  if (totals.costTurns < totals.turns) {
    return `Cost reported for ${totals.costTurns} of ${totals.turns} turns`;
  }
  return "Cost reported by the engine";
}

/** A token count with grouping. A value it cannot read reads as zero. */
export function formatTokenCount(value: number): string {
  const number = usable(value) ?? 0;
  return number.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * A price in US dollars. Cents from a dollar up; enough decimals below that a small turn does not read as `$0.00`.
 */
export function formatUsd(value: number): string {
  const number = usable(value) ?? 0;
  if (number === 0) return "$0.00";
  if (number >= 1) {
    return `$${number.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  // Cents when the price lands on a cent. A fraction of a cent keeps enough digits to not read as $0.00.
  if (number >= 0.01) {
    const cents = number * 100;
    if (Math.abs(cents - Math.round(cents)) < 1e-6) return `$${number.toFixed(2)}`;
    return `$${number.toFixed(3)}`;
  }
  return `$${number.toFixed(4)}`;
}

const CSV_HEADER =
  "Group,Name,Day,Turns,Input tokens,Output tokens,Cache read tokens,Cache write tokens,Cost (USD),Turns with a cost,Turns without a cost";

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(
  group: string,
  name: string,
  day: string,
  totals: UsageTotals,
): string {
  return [
    csvCell(group),
    csvCell(name),
    csvCell(day),
    totals.turns,
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheReadTokens,
    totals.cacheWriteTokens,
    totals.costUsd.toFixed(4),
    totals.costTurns,
    totals.unpricedTurns,
  ].join(",");
}

/** The whole history as CSV, one row per summary, day, project, engine and model. */
export function toCsv(history: UsageHistory): string {
  const rows = [
    CSV_HEADER,
    csvRow("Summary", "Today", "", history.today),
    csvRow("Summary", "Last 7 days", "", history.last7),
    csvRow("Summary", "Last 30 days", "", history.last30),
    ...history.days.map((day) => csvRow("Day", day.day, day.day, day.totals)),
    ...history.byProject.map((group) =>
      csvRow("Project", group.label, "", group.totals),
    ),
    ...history.byEngine.map((group) =>
      csvRow("Engine", group.label, "", group.totals),
    ),
    ...history.byModel.map((group) =>
      csvRow("Model", group.label, "", group.totals),
    ),
  ];
  return `${rows.join("\n")}\n`;
}
