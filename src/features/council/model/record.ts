// WP-23: one council, as stored on its room. Anything read back from disk is checked here and dropped if it is not
// this shape, so a hand-edited or half-written row opens the room with no council instead of throwing.
import type { PanelPreset, Stance, Tally, Verdict } from "./protocol";
import { PANEL_PRESETS } from "./protocol";

export type CouncilPhase = "propose" | "restate" | "running" | "done" | "stopped";
export type CouncilStep = "blind" | "cross" | "stance" | "verdict";

export type CouncilSeatRecord = {
  id: string;
  cli: string;
  family: string;
  label: string;
  model?: string;
  personaId?: string;
  weight: number;
  member: string;
  sessionId: string;
};

export type CouncilAnswerRecord = { seatId: string; member: string; text: string };

export type CouncilMeta = {
  seats: number;
  rounds: number;
  calls: number;
  tokens?: number;
  tokensComplete: boolean;
};

/** The council kept on a room. `revision` is the compare-and-swap counter: a write names the revision it replaces. */
export type CouncilRecord = {
  revision: number;
  generation: number;
  question: string;
  preset: PanelPreset;
  expectedCalls: number;
  phase: CouncilPhase;
  round?: CouncilStep;
  seats: CouncilSeatRecord[];
  blind: CouncilAnswerRecord[];
  cross: CouncilAnswerRecord[];
  stances: Stance[];
  retried: string[];
  skipped: string[];
  tally?: Tally;
  verdict?: Verdict;
  chairmanId?: string;
  chairmanDifferent?: boolean;
  meta: CouncilMeta;
  note?: string;
  /** Dropwave: what this room's council decided before, oldest first, so a new question doesn't wipe the last answer. */
  past?: CouncilPast[];
};

/** One earlier decision, as short as the thread shows it. */
export type CouncilPast = { question: string; consensus: boolean; winner?: string; nextStep?: string; minority?: string };

export const PAST_MAX = 20;

/** The finished council as a line of history, or nothing while it has no verdict. */
export function pastOf(record: CouncilRecord): CouncilPast | undefined {
  if (record.phase !== "done" || !record.tally || !record.verdict) return undefined;
  return {
    question: record.question.slice(0, PAST_TEXT_MAX),
    consensus: record.tally.consensus,
    ...(record.tally.winner ? { winner: record.tally.winner.slice(0, 200) } : {}),
    ...(record.verdict.nextStep ? { nextStep: record.verdict.nextStep.slice(0, PAST_TEXT_MAX) } : {}),
    ...(record.verdict.minority ? { minority: record.verdict.minority.slice(0, PAST_TEXT_MAX) } : {}),
  };
}

/** The history a new question starts with: what was there, plus the council just finished. */
export function carriedPast(record: CouncilRecord): CouncilPast[] {
  const done = pastOf(record);
  return [...(record.past ?? []), ...(done ? [done] : [])].slice(-PAST_MAX);
}

const PAST_TEXT_MAX = 1_000;

function pastFrom(value: unknown): CouncilPast | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.question !== "string" || typeof raw.consensus !== "boolean") return null;
  const text = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  const winner = text(raw.winner, 200);
  const nextStep = text(raw.nextStep, PAST_TEXT_MAX);
  const minority = text(raw.minority, PAST_TEXT_MAX);
  return {
    question: raw.question.slice(0, PAST_TEXT_MAX),
    consensus: raw.consensus,
    ...(winner ? { winner } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(minority ? { minority } : {}),
  };
}

const JSON_MAX = 100_000;
const TEXT_MAX = 8_000;

export function blankProposal(question: string): CouncilRecord {
  return {
    revision: 0,
    generation: 0,
    question: question.trim(),
    preset: "triad",
    expectedCalls: 0,
    phase: "propose",
    seats: [],
    blind: [],
    cross: [],
    stances: [],
    retried: [],
    skipped: [],
    meta: { seats: 0, rounds: 0, calls: 0, tokensComplete: false },
  };
}

/** The record as JSON, or nothing when it is not the shape or it is too big to store. */
export function councilToJson(record: CouncilRecord): string | null {
  const clean = councilFromUnknown(record);
  if (!clean) return null;
  const json = JSON.stringify(clean);
  return json.length <= JSON_MAX ? json : null;
}

export function councilFromUnknown(value: unknown): CouncilRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const preset = raw.preset;
  if (preset !== "quick" && preset !== "triad" && preset !== "full") return null;
  const phase = raw.phase;
  if (phase !== "propose" && phase !== "restate" && phase !== "running" && phase !== "done" && phase !== "stopped") return null;
  const revision = whole(raw.revision);
  const generation = whole(raw.generation);
  const expectedCalls = whole(raw.expectedCalls);
  if (revision === undefined || generation === undefined || expectedCalls === undefined) return null;
  if (typeof raw.question !== "string" || raw.question.length > TEXT_MAX) return null;
  const seats = list(raw.seats, seatFrom);
  const blind = list(raw.blind, answerFrom);
  const cross = list(raw.cross, answerFrom);
  const stances = list(raw.stances, stanceFrom);
  const retried = strings(raw.retried);
  const skipped = strings(raw.skipped);
  const meta = metaFrom(raw.meta);
  if (!seats || !blind || !cross || !stances || !retried || !skipped || !meta) return null;
  const round = raw.round === undefined ? undefined : raw.round === "blind" || raw.round === "cross" || raw.round === "stance" || raw.round === "verdict" ? raw.round : null;
  if (round === null) return null;
  const tally = raw.tally === undefined ? undefined : tallyFrom(raw.tally);
  if (raw.tally !== undefined && !tally) return null;
  const verdict = raw.verdict === undefined ? undefined : verdictFrom(raw.verdict);
  if (raw.verdict !== undefined && !verdict) return null;
  if (seats.length > PANEL_PRESETS.full) return null;
  const record: CouncilRecord = {
    revision,
    generation,
    question: raw.question,
    preset,
    expectedCalls,
    phase,
    ...(round ? { round } : {}),
    seats,
    blind,
    cross,
    stances,
    retried,
    skipped,
    ...(tally ? { tally } : {}),
    ...(verdict ? { verdict } : {}),
    meta,
  };
  if (typeof raw.chairmanId === "string") record.chairmanId = raw.chairmanId.slice(0, 200);
  if (typeof raw.chairmanDifferent === "boolean") record.chairmanDifferent = raw.chairmanDifferent;
  if (typeof raw.note === "string" && raw.note.length <= 500) record.note = raw.note;
  // History that doesn't read is dropped line by line; the council itself stays.
  if (Array.isArray(raw.past)) {
    const past = raw.past.flatMap((item) => pastFrom(item) ?? []).slice(-PAST_MAX);
    if (past.length) record.past = past;
  }
  return record;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

function text(value: unknown, max = TEXT_MAX): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function list<T>(value: unknown, one: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const parsed = one(item);
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

function strings(value: unknown): string[] | undefined {
  return list(value, (item) => (typeof item === "string" && item.length <= 200 ? item : undefined));
}

function seatFrom(value: unknown): CouncilSeatRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 200);
  const cli = text(raw.cli, 80);
  const family = text(raw.family, 80);
  const label = text(raw.label, 120);
  const member = text(raw.member, 40);
  const sessionId = text(raw.sessionId, 300);
  const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight) && raw.weight > 0 && raw.weight <= 10 ? raw.weight : undefined;
  if (!id || !cli || !family || !label || !member || !sessionId || weight === undefined) return undefined;
  const seat: CouncilSeatRecord = { id, cli, family, label, weight, member, sessionId };
  const model = raw.model === undefined ? undefined : text(raw.model, 120);
  if (raw.model !== undefined && !model) return undefined;
  if (model) seat.model = model;
  const personaId = raw.personaId === undefined ? undefined : text(raw.personaId, 80);
  if (raw.personaId !== undefined && !personaId) return undefined;
  if (personaId) seat.personaId = personaId;
  return seat;
}

function answerFrom(value: unknown): CouncilAnswerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const seatId = text(raw.seatId, 200);
  const member = text(raw.member, 40);
  const body = text(raw.text);
  if (!seatId || !member || body === undefined) return undefined;
  return { seatId, member, text: body };
}

function stanceFrom(value: unknown): Stance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const seatId = text(raw.seatId, 200);
  const member = text(raw.member, 40);
  const option = text(raw.option, 120);
  const reason = text(raw.reason, 200);
  const confidence = whole(raw.confidence);
  const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight) && raw.weight > 0 && raw.weight <= 10 ? raw.weight : undefined;
  if (!seatId || !member || !option || !reason || confidence === undefined || confidence > 100 || weight === undefined) return undefined;
  const stance: Stance = { seatId, member, option, confidence, reason, weight };
  if (raw.factor !== undefined) {
    if (raw.factor !== 1 && raw.factor !== 0.75 && raw.factor !== 0.5) return undefined;
    stance.factor = raw.factor;
  }
  if (raw.dealbreaker !== undefined) {
    if (typeof raw.dealbreaker !== "boolean") return undefined;
    if (raw.dealbreaker) stance.dealbreaker = true;
  }
  return stance;
}

function metaFrom(value: unknown): CouncilMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const seats = whole(raw.seats);
  const rounds = whole(raw.rounds);
  const calls = whole(raw.calls);
  if (seats === undefined || rounds === undefined || calls === undefined || typeof raw.tokensComplete !== "boolean") return undefined;
  const meta: CouncilMeta = { seats, rounds, calls, tokensComplete: raw.tokensComplete };
  if (raw.tokens !== undefined) {
    const tokens = whole(raw.tokens);
    if (tokens === undefined) return undefined;
    meta.tokens = tokens;
  }
  return meta;
}

function tallyFrom(value: unknown): Tally | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.consensus !== "boolean") return undefined;
  const total = typeof raw.total === "number" && Number.isFinite(raw.total) && raw.total >= 0 && raw.total <= 1_000_000 ? raw.total : undefined;
  if (total === undefined || typeof raw.line !== "number" || !Number.isFinite(raw.line)) return undefined;
  const options = list(raw.options, (item) => {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    const option = text(row.option, 120);
    const weight = typeof row.weight === "number" && Number.isFinite(row.weight) && row.weight >= 0 ? row.weight : undefined;
    const share = typeof row.share === "number" && Number.isFinite(row.share) ? row.share : undefined;
    return option && weight !== undefined && share !== undefined ? { option, weight, share } : undefined;
  });
  const minority = list(raw.minority, stanceFrom);
  const abstained = strings(raw.abstained);
  if (!options || !minority || !abstained) return undefined;
  const tally: Tally = { consensus: raw.consensus, total, line: raw.line, options, minority, abstained };
  if (raw.winner !== undefined) {
    const winner = text(raw.winner, 120);
    if (!winner) return undefined;
    tally.winner = winner;
  }
  return tally;
}

function verdictFrom(value: unknown): Verdict | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const unresolved = text(raw.unresolved, 2_000);
  const killCriteria = text(raw.killCriteria, 2_000);
  const nextStep = text(raw.nextStep, 500);
  const minority = text(raw.minority, 8_000);
  if (!unresolved || !killCriteria || !nextStep || minority === undefined || typeof raw.fromChairman !== "boolean") return undefined;
  return { unresolved, killCriteria, nextStep, minority, fromChairman: raw.fromChairman };
}
