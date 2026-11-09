// WP-93: how the command palette orders itself. Rebuilt from T3 Code's palette
// ranking behaviour (MIT, idea only, no code taken): a frecency list for an
// empty query, a per-query last pick for three weeks, and a match class ahead
// of usage so a closer name always wins.
import { fuzzyMatch, type FuzzyHit } from "../../../shared/lib/fuzzy";

export const PALETTE_STORAGE_KEY = "monocode.commandPalette";
/** How long a command picked for a query lasts before usage decides again. */
export const PICK_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
/** Bounds, so a long-lived profile cannot grow this without limit. */
export const PALETTE_USES_MAX = 200;
export const PALETTE_PICKS_MAX = 50;
export const PALETTE_QUERY_MAX = 32;
export const PALETTE_RECENT_MAX = 8;
/** Half of a use's weight is gone after this long. */
const USE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Two uses this close together are one visit. */
const USE_DEDUPE_MS = 10 * 60 * 1000;

export type PaletteUse = { id: string; at: number; count: number };
export type PalettePick = { query: string; id: string; at: number };
export type PaletteState = { uses: PaletteUse[]; picks: PalettePick[] };

export type RankedCommandInput = {
  id: string;
  label: string;
  group: string;
  /** Hidden and shown in place: a recent command repeats here. */
  blockedReason?: string | null;
};

export type PaletteItem =
  | { kind: "heading"; label: string }
  | {
      kind: "command";
      command: RankedCommandInput;
      positions: number[];
      blockedReason: string | null;
    };

const emptyState = (): PaletteState => ({ uses: [], picks: [] });

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Folds case, spacing and length so "New" and "  new " are the same pick. */
export function foldQuery(query: string): string {
  // Array.from keeps an emoji in one piece when the cut lands inside it.
  return Array.from(query.trim().toLowerCase())
    .slice(0, PALETTE_QUERY_MAX)
    .join("");
}

/** Reads the stored history. A corrupt or missing value is an empty history. */
export function loadPaletteState(): PaletteState {
  try {
    const raw = globalThis.localStorage?.getItem(PALETTE_STORAGE_KEY);
    if (!raw) return emptyState();
    return parsePaletteState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

function parsePaletteState(value: unknown): PaletteState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyState();
  }
  const record = value as { uses?: unknown; picks?: unknown };
  const uses: PaletteUse[] = [];
  for (const entry of Array.isArray(record.uses) ? record.uses : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { id?: unknown; at?: unknown; count?: unknown };
    if (!nonBlank(row.id) || !finite(row.at)) continue;
    const count = finite(row.count) && row.count > 0 ? Math.floor(row.count) : 1;
    uses.push({ id: row.id, at: row.at, count });
  }
  const picks: PalettePick[] = [];
  for (const entry of Array.isArray(record.picks) ? record.picks : []) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { query?: unknown; id?: unknown; at?: unknown };
    if (!nonBlank(row.query) || !nonBlank(row.id) || !finite(row.at)) continue;
    picks.push({ query: foldQuery(row.query), id: row.id, at: row.at });
  }
  return { uses: boundUses(uses), picks: boundPicks(picks) };
}

function boundUses(uses: PaletteUse[]): PaletteUse[] {
  return [...uses].sort((a, b) => b.at - a.at).slice(0, PALETTE_USES_MAX);
}

function boundPicks(picks: PalettePick[]): PalettePick[] {
  return [...picks].sort((a, b) => b.at - a.at).slice(0, PALETTE_PICKS_MAX);
}

/** Writes the history. A storage that refuses is not an error a person needs. */
export function savePaletteState(state: PaletteState): void {
  try {
    globalThis.localStorage?.setItem(PALETTE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode or quota */
  }
}

/** One use of a command, folded into the one row it already has. */
export function recordPaletteUse(
  state: PaletteState,
  id: string,
  now: number,
): PaletteState {
  if (!nonBlank(id) || !finite(now)) return state;
  const existing = state.uses.find((use) => use.id === id);
  const at = existing ? Math.max(existing.at, now) : now;
  const withinVisit = existing !== undefined && at - existing.at < USE_DEDUPE_MS;
  const count = existing ? existing.count + (withinVisit ? 0 : 1) : 1;
  const uses = [
    { id, at, count },
    ...state.uses.filter((use) => use.id !== id),
  ];
  return { ...state, uses: boundUses(uses) };
}

/** Remember the command picked for a query: it goes first for that query. */
export function recordPalettePick(
  state: PaletteState,
  query: string,
  id: string,
  now: number,
): PaletteState {
  const folded = foldQuery(query);
  if (!folded || !nonBlank(id) || !finite(now)) return state;
  const picks = [
    { query: folded, id, at: now },
    ...state.picks.filter((pick) => pick.query !== folded),
  ];
  return { ...state, picks: boundPicks(picks) };
}

/**
 * The pick still in force for a query: the newest one recorded for exactly
 * this query or for the start of it, when only a few more words were typed.
 */
export function activePick(
  state: PaletteState,
  query: string,
  now: number,
): PalettePick | null {
  const folded = foldQuery(query);
  if (!folded) return null;
  const live = state.picks.filter(
    (pick) => now - pick.at < PICK_WINDOW_MS && now >= pick.at,
  );
  const exact = live
    .filter((pick) => pick.query === folded)
    .sort((a, b) => b.at - a.at)[0];
  if (exact) return exact;
  if (folded.length < 3) return null;
  return (
    live
      .filter((pick) => foldQuery(query).startsWith(pick.query))
      .sort((a, b) => b.at - a.at)[0] ?? null
  );
}

/** A use's weight: fresh matters most, then how often. Never below 0. */
function useWeight(use: PaletteUse, now: number): number {
  const age = Math.max(0, now - use.at);
  const recency = Math.pow(2, -age / USE_HALF_LIFE_MS);
  const frequency = Math.log2(1 + use.count);
  return recency + frequency;
}

function byText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
}

/**
 * What the palette shows. An empty query is the last commands used, then the
 * rest by group. A typed query is matches in rank order, with no headings.
 */
export function paletteList(
  commands: readonly RankedCommandInput[],
  query: string,
  state: PaletteState,
  now: number,
): PaletteItem[] {
  const text = query.trim();
  const known = new Map(commands.map((command) => [command.id, command]));
  const uses = new Map(
    state.uses.filter((use) => known.has(use.id)).map((use) => [use.id, use]),
  );
  if (!text) return recentThenGroups(commands, uses);

  const pick = activePick(state, text, now);
  const scored = commands.flatMap((command) => {
    const hit = scoreCommand(text, command);
    if (!hit) return [];
    return [{ command, ...hit }];
  });
  scored.sort((a, b) => {
    const classA = matchClass(a, text);
    const classB = matchClass(b, text);
    if (classA !== classB) return classB - classA;
    if (pick) {
      if (a.command.id === pick.id && b.command.id !== pick.id) return -1;
      if (b.command.id === pick.id && a.command.id !== pick.id) return 1;
    }
    const weightA = uses.get(a.command.id);
    const weightB = uses.get(b.command.id);
    const aWeight = weightA ? useWeight(weightA, now) : 0;
    const bWeight = weightB ? useWeight(weightB, now) : 0;
    if (aWeight !== bWeight) return bWeight - aWeight;
    if (a.hit.score !== b.hit.score) return b.hit.score - a.hit.score;
    return byText(a.command.label, b.command.label) || byText(a.command.id, b.command.id);
  });
  return scored.map((entry): PaletteItem => ({
    kind: "command",
    command: entry.command,
    positions: entry.positions,
    blockedReason: entry.command.blockedReason ?? null,
  }));
}

/** How well a command answers a query: the better of its name and its group. */
function scoreCommand(
  text: string,
  command: RankedCommandInput,
): { hit: FuzzyHit; positions: number[] } | null {
  const onLabel = fuzzyMatch(text, command.label);
  const onGroup =
    command.group && command.label !== command.group
      ? fuzzyMatch(text, `${command.group} ${command.label}`)
      : null;
  if (onLabel && (!onGroup || onLabel.score >= onGroup.score)) {
    return { hit: onLabel, positions: onLabel.positions };
  }
  if (onGroup) {
    // The group's letters have no place in the label; highlight what does fit.
    const labelHit = fuzzyMatch(text, command.label);
    return { hit: onGroup, positions: labelHit?.positions ?? [] };
  }
  return null;
}

const WORD_BREAK = /[ /\\\-_.:]/;

/** 3: the whole name, 2: the name starts with it, 1: anything else. */
function matchClass(
  entry: { command: RankedCommandInput; hit: FuzzyHit },
  text: string,
): number {
  const needle = text.toLowerCase();
  const label = entry.command.label.toLowerCase();
  if (needle === label) return 3;
  if (label.startsWith(needle)) return 2;
  const first = entry.hit.positions[0];
  const wholeWord =
    first === 0 || (first !== undefined && WORD_BREAK.test(label[first - 1] ?? ""));
  return wholeWord ? 1 : 0;
}

function recentThenGroups(
  commands: readonly RankedCommandInput[],
  uses: Map<string, PaletteUse>,
): PaletteItem[] {
  const recent = [...uses.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, PALETTE_RECENT_MAX)
    .flatMap((use) => {
      const command = commands.find((entry) => entry.id === use.id);
      return command ? [command] : [];
    });
  const shown = new Set(recent.map((command) => command.id));
  const ordered: PaletteItem[] = [];
  if (recent.length) {
    ordered.push({ kind: "heading", label: "Recent" });
    for (const command of recent) {
      ordered.push({
        kind: "command",
        command,
        positions: [],
        blockedReason: command.blockedReason ?? null,
      });
    }
  }
  const groups = new Map<string, RankedCommandInput[]>();
  for (const command of commands) {
    if (shown.has(command.id)) continue;
    const list = groups.get(command.group) ?? [];
    list.push(command);
    groups.set(command.group, list);
  }
  for (const [group, list] of groups) {
    ordered.push({ kind: "heading", label: group });
    for (const command of [...list].sort((a, b) => byText(a.label, b.label))) {
      ordered.push({
        kind: "command",
        command,
        positions: [],
        blockedReason: command.blockedReason ?? null,
      });
    }
  }
  return ordered;
}

/** The commands among a list of items, for arrow keys and Enter. */
export function commandItems(items: readonly PaletteItem[]): Array<
  Extract<PaletteItem, { kind: "command" }>
> {
  return items.flatMap((item) => (item.kind === "command" ? [item] : []));
}

/**
 * The next row an arrow key may land on. Greyed commands are stepped over so
 * Enter can never run one; with nothing runnable the answer is -1.
 */
export function stepRunnable(
  commands: readonly { blockedReason: string | null }[],
  from: number,
  delta: number,
): number {
  const count = commands.length;
  if (count === 0) return -1;
  const start = from >= 0 && from < count ? from : delta > 0 ? -1 : 0;
  for (let step = 1; step <= count; step++) {
    const index = (((start + delta * step) % count) + count) % count;
    if (!commands[index]?.blockedReason) return index;
  }
  return -1;
}
