// WP-23: the council's rules, in code (docs/hivra/work/WP-23-council.md, SPEC.md section 6).
//
// The protocol — a blind first round, an anonymised cross-exam, a stance line, a two-thirds tally that keeps the
// minority, a chairman on another provider — comes from council-of-high-intelligence. The prompt text is copied in
// prompts.ts. Here each step is a function: a prompt is built with only what that step may see, and a reply that
// is the wrong shape is asked again once, then set aside. Nothing here calls a model.

import { BLIND_TEMPLATE, CHAIRMAN_TEMPLATE, CROSS_TEMPLATE, STANCE_TEMPLATE } from "./prompts";

export const PANEL_PRESETS = { quick: 2, triad: 3, full: 5 } as const;
export type PanelPreset = keyof typeof PANEL_PRESETS;

/** One engine that can take a seat. `family` is the model family (Anthropic, OpenAI, …), not the model id. */
export type CouncilEngine = {
  cli: string;
  family: string;
  label: string;
  model?: string;
};

export type ProposedSeat = {
  cli: string;
  family: string;
  label: string;
  model?: string;
  personaId?: string;
};

export type Proposal = {
  preset: PanelPreset;
  /** Seats the preset asked for, before availability cut it down. */
  asked: number;
  seats: ProposedSeat[];
  expectedCalls: number;
  note?: string;
};

/** A seated member, once the person has confirmed. `member` is the public name ("Member A"); the real name stays off the cross-exam. */
export type CouncilSeat = {
  id: string;
  cli: string;
  family: string;
  label: string;
  model?: string;
  personaId?: string;
  /** How many votes this seat casts. A persona may set it; otherwise 1. */
  weight: number;
  member: string;
  sessionId: string;
};

export type Stance = {
  seatId: string;
  member: string;
  option: string;
  confidence: number;
  reason: string;
  weight: number;
  /** Vote factor from CONFIDENCE high, med or low. Omitted means 1, so a displayed 0–100 does not shrink the vote. */
  factor?: number;
  /** The seat called the other option actively harmful. The minority report keeps that even when they lose. */
  dealbreaker?: boolean;
};

export type Tally = {
  /** Set only when one option's weight reaches two thirds of the weight that voted. */
  winner?: string;
  consensus: boolean;
  /** Base weight counted, abstentions included. Confidence does not shrink this, so a hesitant panel cannot lower the bar. */
  total: number;
  /** The two-thirds line, as a fraction of `total`. Zero when nobody voted. */
  line: number;
  options: { option: string; weight: number; share: number }[];
  /** Every stance that is not the winner. Empty only when the room was unanimous. When there is no winner, every stance. */
  minority: Stance[];
  abstained: string[];
};

export type Verdict = {
  unresolved: string;
  killCriteria: string;
  nextStep: string;
  /** Always the tally's minority report, never a model's paraphrase of it. */
  minority: string;
  /** The chairman wrote this. False when the reply was the wrong shape twice and the tally stands in. */
  fromChairman: boolean;
};

export const TWO_THIRDS = 2 / 3;
const OPTION_MAX = 120;
const REASON_MAX = 200;
const SECTION_MAX = 2_000;
const ANSWER_MAX = 8_000;

export function presetSize(preset: PanelPreset): number {
  return PANEL_PRESETS[preset];
}

/**
 * Calls a run makes when every reply is the right shape the first time: each seat answers blind, cross-examines and
 * states a position, then the chairman writes the verdict. A retry is an extra call, not part of this number.
 */
export function expectedCalls(seats: number): number {
  if (!Number.isInteger(seats) || seats < 1) return 0;
  return seats * 3 + 1;
}

/** True when `weight` is at least two thirds of `total`. Exact at the line (2 of 3, 4 of 6). Integer arithmetic, so 3 of 5 does not pass. */
export function reachesTwoThirds(weight: number, total: number): boolean {
  if (!Number.isFinite(weight) || !Number.isFinite(total) || total <= 0 || weight <= 0) return false;
  return weight * 3 >= total * 2;
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Same position written two ways ("Ship  it", "ship it") is one option. The first spelling is the one shown. */
export function optionKey(option: string): string {
  return clean(option).toLowerCase();
}

/**
 * A panel of at most the preset's size, one seat per engine and model family that is actually available. The same
 * engine and family twice is one seat. When fewer are available than the preset asks for, the panel is smaller and
 * says so; it does not invent a second seat on an engine just to fill the number.
 */
export function proposePanel(engines: readonly CouncilEngine[], preset: PanelPreset): Proposal {
  const asked = presetSize(preset);
  const pool: { engine: CouncilEngine; index: number }[] = [];
  const seen = new Set<string>();
  engines.forEach((engine, index) => {
    const cli = engine.cli.trim();
    const family = engine.family.trim();
    const label = engine.label.trim();
    if (!cli || !family || !label) return;
    const key = `${cli.toLowerCase()}\u0000${family.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    pool.push({
      engine: { cli, family, label, ...(engine.model?.trim() ? { model: engine.model.trim() } : {}) },
      index,
    });
  });
  const picked: typeof pool = [];
  while (picked.length < asked && pool.length) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) if (outranks(pool[i], pool[best], picked)) best = i;
    picked.push(pool.splice(best, 1)[0]);
  }
  picked.sort((a, b) => a.index - b.index);
  const seats: ProposedSeat[] = picked.map(({ engine }) => ({ ...engine }));
  const note = !seats.length
    ? "No engine is signed in, so a council can't start."
    : seats.length < asked
      ? `${presetLabel(preset)} asks for ${asked} seats. ${seats.length} ${seats.length === 1 ? "engine is" : "engines are"} signed in, so this council has ${seats.length}.`
      : undefined;
  return { preset, asked, seats, expectedCalls: expectedCalls(seats.length), ...(note ? { note } : {}) };
}

function presetLabel(preset: PanelPreset): string {
  if (preset === "quick") return "Quick";
  if (preset === "triad") return "Triad";
  return "Full";
}

/** Prefer an engine whose family is not seated yet, then one whose CLI is not, then the earlier one in the list. */
function outranks(
  candidate: { engine: CouncilEngine; index: number },
  current: { engine: CouncilEngine; index: number },
  picked: readonly { engine: CouncilEngine }[],
): boolean {
  const family = (engine: CouncilEngine) => (picked.some((p) => sameFamily(p.engine, engine)) ? 1 : 0);
  const cli = (engine: CouncilEngine) => (picked.some((p) => p.engine.cli.toLowerCase() === engine.cli.toLowerCase()) ? 1 : 0);
  const byFamily = family(candidate.engine) - family(current.engine);
  if (byFamily !== 0) return byFamily < 0;
  const byCli = cli(candidate.engine) - cli(current.engine);
  if (byCli !== 0) return byCli < 0;
  return candidate.index < current.index;
}

function sameFamily(a: CouncilEngine, b: CouncilEngine): boolean {
  return a.family.toLowerCase() === b.family.toLowerCase();
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function memberLabel(index: number): string {
  return index >= 0 && index < LETTERS.length ? `Member ${LETTERS[index]}` : `Member ${index + 1}`;
}

/** Seat the proposal. Session ids are the seat's own tab; they are not shown to the other seats. */
export function seatPanel(seats: readonly ProposedSeat[], weights: ReadonlyMap<string, number>, roomId: string): CouncilSeat[] {
  return seats.slice(0, LETTERS.length).map((seat, index) => {
    const id = seatId(seat, index);
    const raw = seat.personaId ? weights.get(seat.personaId) : undefined;
    const weight = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 10 ? raw : 1;
    return {
      id,
      cli: seat.cli,
      family: seat.family,
      label: seat.label,
      ...(seat.model ? { model: seat.model } : {}),
      ...(seat.personaId ? { personaId: seat.personaId } : {}),
      weight,
      member: memberLabel(index),
      sessionId: `council:${roomId}:${id}`,
    };
  });
}

function seatId(seat: ProposedSeat, index: number): string {
  const slug = `${seat.cli}-${seat.family}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "seat"}-${index + 1}`;
}

/**
 * The chairman writes the verdict and does not count the votes. When one family holds strictly the most seats and
 * another family is seated, the chairman is the first seat of another family. When every seat is one family, a seat
 * still chairs and `differentProvider` is false.
 */
export function chooseChairman(seats: readonly Pick<CouncilSeat, "id" | "family">[]): { seatId: string; differentProvider: boolean } | undefined {
  if (!seats.length) return undefined;
  const counts = new Map<string, number>();
  for (const seat of seats) counts.set(seat.family.toLowerCase(), (counts.get(seat.family.toLowerCase()) ?? 0) + 1);
  let top = 0;
  let leaders = 0;
  for (const count of counts.values()) {
    if (count > top) {
      top = count;
      leaders = 1;
    } else if (count === top) leaders += 1;
  }
  const majority = leaders === 1 ? [...counts.entries()].find(([, count]) => count === top)?.[0] : undefined;
  if (majority) {
    const other = seats.find((seat) => seat.family.toLowerCase() !== majority);
    if (other) return { seatId: other.id, differentProvider: true };
  }
  const chair = seats[seats.length - 1];
  return { seatId: chair.id, differentProvider: counts.size > 1 && seats.some((seat) => seat.family.toLowerCase() !== chair.family.toLowerCase()) };
}

export type PersonaBrief = { id: string; name: string; text: string; method?: string };

/** What one seat is told for the blind round. No other seat, and no other answer, is in it. */
export function blindPrompt(question: string, persona: PersonaBrief | undefined): string {
  const identity = persona ? `${persona.name}\n${persona.text.trim()}` : "";
  return BLIND_TEMPLATE.replace("{identity}", identity)
    .replace("{problem}", question.trim())
    .replace("{restatements}", "The person confirmed the question above before this round.")
    .replace("{reasoning_method}", persona?.method?.trim() || "the method in your role");
}

/**
 * Hide every seat's real name, engine, family, model and persona behind its member letter. Longer phrases go first, so
 * "Claude Code" is hidden before "Claude". A needle shorter than two letters is left alone (it would eat ordinary words).
 */
export function anonymise(text: string, seats: readonly { member: string; needles: readonly string[] }[]): string {
  const swaps: { needle: string; member: string }[] = [];
  for (const seat of seats) {
    for (const needle of seat.needles) {
      const cleanNeedle = needle.trim();
      if (cleanNeedle.length < 2) continue;
      if (cleanNeedle.toLowerCase() === seat.member.toLowerCase()) continue;
      swaps.push({ needle: cleanNeedle, member: seat.member });
    }
  }
  swaps.sort((a, b) => b.needle.length - a.needle.length);
  let out = text;
  for (const swap of swaps) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(swap.needle)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, swap.member);
  }
  return out;
}

export function seatNeedles(seat: CouncilSeat, personaName?: string): string[] {
  return [seat.label, seat.cli, seat.family, seat.model ?? "", seat.id, seat.sessionId, personaName ?? ""].filter((n) => n.trim().length >= 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The cross-exam. Names are already hidden; this prompt must not be given the seats' real names. `{name}` is the member letter. */
export function crossPrompt(question: string, me: string, answers: readonly { member: string; text: string }[]): string {
  const lines = answers.map((answer) => `${answer.member}:\n${answer.text.trim()}`).join("\n\n");
  return `${CROSS_TEMPLATE.split("{name}").join(me).replace("{outputs}", lines)}\n\nQuestion:\n${question.trim()}`;
}

export const STANCE_SHAPE = "STANCE: <one short option label> | CONFIDENCE: high|med|low | DEALBREAKER: yes|no";

export function stancePrompt(question: string, me: string, answers: readonly { member: string; text: string }[], cross: readonly { member: string; text: string }[]): string {
  return [
    STANCE_TEMPLATE,
    "",
    `You are ${me}. Names stay hidden.`,
    "",
    "Question:",
    question.trim(),
    "",
    "Blind answers, with names hidden:",
    answers.map((answer) => `${answer.member}: ${answer.text.trim()}`).join("\n\n"),
    "",
    "Cross-examination, with names hidden:",
    cross.map((answer) => `${answer.member}: ${answer.text.trim()}`).join("\n\n"),
  ].join("\n");
}

export function retryPrompt(shape: string, problem: string): string {
  return [`Your last reply was not in the right shape: ${problem}`, "Reply again in exactly this shape, and nothing else.", "", shape].join("\n");
}

export type ParsedStance = { option: string; confidence: number; reason: string; factor?: number; dealbreaker?: boolean };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * A final position. The copied protocol puts one STANCE line last. The three-line OPTION / CONFIDENCE / REASON shape
 * is still accepted, so a reply written that way is not thrown away. Prose with no stance line is not a stance.
 */
export function parseStance(text: string): ParseResult<ParsedStance> {
  const lines = nonEmpty(text);
  const last = lines[lines.length - 1] ?? "";
  if (/^STANCE:/i.test(last)) return parseStanceLine(last, lines.length > 1 ? lines[lines.length - 2] : undefined);
  if (lines.length !== 3) return { ok: false, problem: "the last line must be STANCE, CONFIDENCE (high, med or low) and DEALBREAKER (yes or no)." };
  const option = field(lines[0], "OPTION");
  const confidence = field(lines[1], "CONFIDENCE");
  const reason = field(lines[2], "REASON");
  if (option === undefined || confidence === undefined || reason === undefined)
    return { ok: false, problem: "the lines must be OPTION, then CONFIDENCE, then REASON." };
  if (!option || option.length > OPTION_MAX) return { ok: false, problem: `OPTION must be 1 to ${OPTION_MAX} characters.` };
  if (!/^\d{1,3}$/.test(confidence)) return { ok: false, problem: "CONFIDENCE must be a whole number from 0 to 100." };
  const n = Number(confidence);
  if (n > 100) return { ok: false, problem: "CONFIDENCE must be a whole number from 0 to 100." };
  if (!reason || reason.includes("\n") || reason.length > REASON_MAX) return { ok: false, problem: `REASON must be one line of 1 to ${REASON_MAX} characters.` };
  return { ok: true, value: { option, confidence: n, reason } };
}

/**
 * `STANCE: <label> | CONFIDENCE: high|med|low | DEALBREAKER: yes|no`, or a bare `STANCE: abstain`.
 * The line above, when there is one, is that seat's own reason. The dealbreaker flag is kept as well.
 */
function parseStanceLine(line: string, sentence?: string): ParseResult<ParsedStance> {
  if (sentence && sentence.length > REASON_MAX) return { ok: false, problem: `REASON must be one line of 1 to ${REASON_MAX} characters.` };
  if (/^STANCE:\s*abstain\s*$/i.test(line)) {
    return { ok: true, value: { option: "abstain", confidence: 0, reason: "Abstained.", factor: 1, dealbreaker: false } };
  }
  const match = /^STANCE:\s*(.+?)\s*\|\s*CONFIDENCE:\s*(high|med|low)\s*\|\s*DEALBREAKER:\s*(yes|no)\s*$/i.exec(line.trim());
  if (!match) return { ok: false, problem: "the last line must be STANCE, CONFIDENCE (high, med or low) and DEALBREAKER (yes or no)." };
  const option = match[1].trim();
  if (!option || option.length > OPTION_MAX) return { ok: false, problem: `STANCE must be 1 to ${OPTION_MAX} characters.` };
  const word = match[2].toLowerCase();
  const confidence = word === "high" ? 100 : word === "med" ? 75 : 50;
  const factor = word === "high" ? 1 : word === "med" ? 0.75 : 0.5;
  const dealbreaker = match[3].toLowerCase() === "yes";
  if (optionKey(option) === "abstain") {
    return { ok: true, value: { option: "abstain", confidence, reason: "Abstained.", factor: 1, dealbreaker: false } };
  }
  const reason = sentence || (dealbreaker ? "Dealbreaker." : "Not a dealbreaker.");
  return { ok: true, value: { option, confidence, reason, factor, dealbreaker } };
}

function field(line: string, label: string): string | undefined {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "i").exec(line.trim());
  return match ? match[1].trim() : undefined;
}

function nonEmpty(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
}

function voteFactor(stance: Stance): number {
  return stance.factor === 1 || stance.factor === 0.75 || stance.factor === 0.5 ? stance.factor : 1;
}

export function tally(stances: readonly Stance[], seated: readonly Pick<CouncilSeat, "id" | "member">[]): Tally {
  const voted = new Set(stances.map((stance) => stance.seatId));
  const abstained = seated.filter((seat) => !voted.has(seat.id)).map((seat) => seat.member);
  const display = new Map<string, string>();
  const weight = new Map<string, number>();
  let total = seated.filter((seat) => !voted.has(seat.id)).length;
  const cast: Stance[] = [];
  for (const stance of stances) {
    const base = Number.isFinite(stance.weight) && stance.weight > 0 ? stance.weight : 1;
    total += base;
    if (optionKey(stance.option) === "abstain") {
      abstained.push(stance.member);
      continue;
    }
    const key = optionKey(stance.option);
    if (!key) continue;
    cast.push(stance);
    if (!display.has(key)) display.set(key, clean(stance.option).slice(0, OPTION_MAX));
    weight.set(key, (weight.get(key) ?? 0) + base * voteFactor(stance));
  }
  const options = [...weight.entries()]
    .map(([key, w]) => ({ option: display.get(key) ?? key, weight: w, share: total > 0 ? w / total : 0 }))
    .sort((a, b) => b.weight - a.weight || a.option.localeCompare(b.option));
  const winner = options.find((option) => reachesTwoThirds(option.weight, total))?.option;
  const minority = winner ? cast.filter((stance) => optionKey(stance.option) !== optionKey(winner)) : [...cast];
  return { ...(winner ? { winner } : {}), consensus: !!winner, total, line: total > 0 ? (total * 2) / 3 : 0, options, minority, abstained };
}

/** The minority report the chairman must carry, and that the verdict keeps even if the chairman drops it. */
export function minorityReport(result: Tally): string {
  if (result.options.length === 0) return "No seat gave a final position.";
  const lines = result.minority.map((stance) => `${stance.member} — ${clean(stance.option)} (${stance.confidence}): ${stance.reason}`);
  if (!result.consensus) return `No consensus\n${lines.join("\n")}`;
  return lines.length ? lines.join("\n") : "No one disagreed.";
}

export const VERDICT_SHAPE = ["UNRESOLVED:", "<questions still open, or None>", "KILL CRITERIA:", "<what would make this the wrong call, or None>", "NEXT STEP:", "<one concrete step>", "MINORITY REPORT:", "<the minority report, unchanged>"].join("\n");

export function verdictPrompt(
  question: string,
  result: Tally,
  report: string,
  transcript?: { blind: readonly { member: string; text: string }[]; cross: readonly { member: string; text: string }[]; stances: readonly Stance[] },
): string {
  const counts = result.options.map((option) => `${option.option}: ${option.weight} of ${result.total}`).join("\n");
  const show = (rows: readonly { member: string; text: string }[]) => rows.map((row) => `${row.member}:\n${row.text.trim()}`).join("\n\n");
  const positions = (transcript?.stances ?? []).map((stance) => `${stance.member}: ${stance.option} (${stance.confidence}). ${stance.reason}`).join("\n");
  const chairman = CHAIRMAN_TEMPLATE.replace("{problem}", question.trim())
    .replace("{round1}", transcript ? show(transcript.blind) : "Not collected.")
    .replace("{round2}", transcript ? show(transcript.cross) : "Not collected.")
    .replace("{round3}", positions || "Not collected.");
  return [
    chairman,
    "",
    "The tally below is final. Do not change it, and do not invent a winner the tally does not have.",
    result.consensus ? `The council agreed on: ${result.winner}` : "The council did not reach two thirds. Do not invent a winner.",
    "Tally:",
    counts || "No votes.",
    "",
    "Write the verdict in exactly this shape, and nothing else. No greeting, no code fence.",
    "",
    VERDICT_SHAPE,
    "",
    "Minority report, copy this into MINORITY REPORT unchanged:",
    report,
  ].join("\n");
}

const VERDICT_HEADS = ["UNRESOLVED:", "KILL CRITERIA:", "NEXT STEP:", "MINORITY REPORT:"] as const;

export function parseVerdict(text: string): ParseResult<Pick<Verdict, "unresolved" | "killCriteria" | "nextStep" | "minority">> {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at: number[] = [];
  for (const head of VERDICT_HEADS) {
    const from = at.length ? at[at.length - 1] + 1 : 0;
    const found = lines.findIndex((line, index) => index >= from && line.trim().toUpperCase() === head);
    if (found < 0) return { ok: false, problem: `it needs the heading ${head}` };
    if (at.length && found < at[at.length - 1]) return { ok: false, problem: "the headings are in the wrong order." };
    at.push(found);
  }
  const before = lines.slice(0, at[0]).some((line) => line.trim());
  if (before) return { ok: false, problem: "it has text before UNRESOLVED." };
  const bodies = VERDICT_HEADS.map((_, index) => lines.slice(at[index] + 1, index + 1 < at.length ? at[index + 1] : lines.length).join("\n").trim());
  if (bodies.some((body) => !body || body.length > SECTION_MAX)) return { ok: false, problem: "each section needs text, and none may be longer than a page." };
  const next = bodies[2].split("\n").map((line) => line.trim()).filter(Boolean);
  if (next.length !== 1) return { ok: false, problem: "NEXT STEP must be one line." };
  return { ok: true, value: { unresolved: bodies[0], killCriteria: bodies[1], nextStep: next[0], minority: bodies[3] } };
}

/** When the chairman's reply is the wrong shape twice, the tally still produces a verdict. The minority report is the code's. */
export function fallbackVerdict(result: Tally, report: string): Verdict {
  return {
    unresolved: "The chairman didn't return a verdict in the right shape.",
    killCriteria: "None stated.",
    nextStep: result.consensus && result.winner ? `Take the next step on "${result.winner}".` : "No consensus. Decide this yourself.",
    minority: report,
    fromChairman: false,
  };
}

export function capAnswer(text: string): string {
  const flat = text.replace(/\r\n?/g, "\n").trim();
  return flat.length > ANSWER_MAX ? `${flat.slice(0, ANSWER_MAX)}…` : flat;
}
