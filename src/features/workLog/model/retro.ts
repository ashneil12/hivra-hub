// WP-157: the weekly summary reads the last 7 days, counts what shipped, failed and was sent
// back, and proposes an edit for each correction Ash gave (a `feedback` line), word for word.
// It writes no sentence of its own into an opinion: sent back and failed work is counted, not
// turned into advice. It never applies anything. The proposals are staged as pending learn store
// changes (retroStage.ts, retroStore.ts) and the learn store's own accept writes one, only after
// the person accepts it. It does not ask the first mate: the app has no way for a first mate to
// stage an edit, so a request sent to one would have nowhere to land.

import { sha256 } from "../../memory/backpass/sha";
import { isDay, shiftDay, type WorkLogLine } from "./workLog";

export const RETRO_EDIT_CAP = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The log line a proposed edit rests on, kept so the person can see why it was proposed. */
export type Evidence = { day: string; line: string };

export type PendingEdit = {
  /** Follows the file and the words, so the same edit found again is the same edit. */
  id: string;
  file: "opinions.md";
  title: string;
  text: string;
  evidence: Evidence[];
};

export type RetroCounts = { shipped: number; failed: number; sentBack: number; feedback: number };

export type RetroResult = {
  from: string;
  to: string;
  shipped: string[];
  counts: RetroCounts;
  report: string;
  pending: PendingEdit[];
  applied: false;
};

export type WeeklyRetro = { enabled: boolean; lastAskedAt: string | null };

function starts(line: string, lead: string): boolean {
  return line.startsWith(lead);
}

export function retroEditId(file: string, text: string): string {
  return `retro:${sha256(`${file}\n${text}`).slice(0, 16)}`;
}

const TITLE_WORDS_CAP = 50;

/** Each correction gets a title of its own, so the screen's Accept and Reject buttons tell them apart. */
export function correctionTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_WORDS_CAP) return `Correction: ${line}`;
  const cut = line.slice(0, TITLE_WORDS_CAP);
  const at = cut.lastIndexOf(" ");
  return `Correction: ${(at > 20 ? cut.slice(0, at) : cut).replace(/[.,;:\s]+$/, "")}...`;
}

function proposed(title: string, text: string, evidence: Evidence[]): PendingEdit {
  return { id: retroEditId("opinions.md", text), file: "opinions.md", title, text, evidence };
}

function seen(line: WorkLogLine): Evidence {
  return { day: line.day, line: line.line };
}

function empty(report: string): RetroResult {
  return {
    from: "",
    to: "",
    shipped: [],
    counts: { shipped: 0, failed: 0, sentBack: 0, feedback: 0 },
    report,
    pending: [],
    applied: false,
  };
}

/**
 * The last 7 days, including today. The counts come from the outcome lines and the proposed
 * edits come only from correction lines. Nothing is written: `applied` stays false, and this
 * function takes no writer.
 */
export function stageRetro(lines: readonly WorkLogLine[], today: string): RetroResult {
  if (!isDay(today)) return empty("The day should look like 2026-11-10.");
  const from = shiftDay(today, -6);
  const week = lines.filter((line) => line.day >= from && line.day <= today);
  const outcomes = week.filter((line) => line.kind === "outcome");
  const shipped = outcomes.filter((line) => starts(line.line, "Done:")).map((line) => line.line);
  const failedLines = outcomes.filter((line) => starts(line.line, "Failed:"));
  const sentBackLines = outcomes.filter((line) => starts(line.line, "Sent back:"));
  const failed = failedLines.length;
  const sentBack = sentBackLines.length;
  const feedback = week.filter((line) => line.kind === "feedback");
  const counts: RetroCounts = { shipped: shipped.length, failed, sentBack, feedback: feedback.length };

  const pending: PendingEdit[] = [];
  for (const line of feedback) {
    const edit = proposed(correctionTitle(line.line), line.line, [seen(line)]);
    // The same correction on two days is one edit with two lines behind it.
    const same = pending.find((row) => row.id === edit.id);
    if (same) same.evidence.push(seen(line));
    else if (pending.length < RETRO_EDIT_CAP) pending.push(edit);
  }

  const shippedLines = shipped.length === 0 ? "Nothing shipped." : shipped.join("\n");
  const report = [
    `From ${from} to ${today}.`,
    `Shipped: ${counts.shipped}.`,
    `Failed: ${counts.failed}.`,
    `Sent back: ${counts.sentBack}.`,
    `Feedback: ${counts.feedback}.`,
    shippedLines,
  ].join("\n");
  return { from, to: today, shipped, counts, report, pending, applied: false };
}

export function defaultWeeklyRetro(): WeeklyRetro {
  return { enabled: false, lastAskedAt: null };
}

/** A saved routine is untrusted. Anything that is not exactly on comes back off. */
export function parseWeeklyRetro(value: unknown): WeeklyRetro {
  if (!value || typeof value !== "object") return defaultWeeklyRetro();
  const row = value as { enabled?: unknown; lastAskedAt?: unknown };
  const stamp = typeof row.lastAskedAt === "string" ? row.lastAskedAt : "";
  const lastAskedAt = Number.isFinite(Date.parse(stamp)) ? stamp : null;
  return { enabled: row.enabled === true, lastAskedAt };
}

/** Due only when the routine is on, and it has never asked or a week has passed. */
export function weeklyRetroDue(routine: WeeklyRetro, nowMs: number): boolean {
  if (!routine || routine.enabled !== true) return false;
  if (!routine.lastAskedAt) return true;
  const at = Date.parse(routine.lastAskedAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= WEEK_MS;
}

/** Remember that the routine asked. Off, or a bad time, is left alone. */
export function markAsked(routine: WeeklyRetro, at: string): WeeklyRetro {
  if (!routine || routine.enabled !== true) return routine;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return routine;
  return { ...routine, lastAskedAt: at };
}

const STORAGE_KEY = "monocode:work-log-weekly-retro";

export function loadWeeklyRetro(): WeeklyRetro {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWeeklyRetro();
    return parseWeeklyRetro(JSON.parse(raw));
  } catch {
    return defaultWeeklyRetro();
  }
}

export function saveWeeklyRetro(routine: WeeklyRetro): void {
  try {
    const parsed = parseWeeklyRetro(routine);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // A private window or a full disk does not turn the routine on.
  }
}

/** Turning the routine on starts the week from now, so it does not ask immediately. */
export function enableWeeklyRetro(at: string): WeeklyRetro {
  return markAsked({ enabled: true, lastAskedAt: null }, at);
}
