// WP-157: a retro reads the last 7 days and proposes edits. It never applies them.
// Applying is the learn store's accept, and only after the person accepts each one.

import { isDay, shiftDay, type WorkLogLine } from "./workLog";

export const RETRO_EDIT_CAP = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingEdit = {
  id: string;
  file: "opinions.md";
  title: string;
  text: string;
};

export type RetroCounts = { shipped: number; failed: number; sentBack: number; feedback: number };

export type RetroResult = {
  from: string;
  to: string;
  shipped: string[];
  counts: RetroCounts;
  report: string;
  ask: string;
  pending: PendingEdit[];
  applied: false;
};

export type WeeklyRetro = { enabled: boolean; lastAskedAt: string | null };

function starts(line: string, lead: string): boolean {
  return line.startsWith(lead);
}

function empty(report: string): RetroResult {
  return {
    from: "",
    to: "",
    shipped: [],
    counts: { shipped: 0, failed: 0, sentBack: 0, feedback: 0 },
    report,
    ask: "",
    pending: [],
    applied: false,
  };
}

/**
 * The last 7 days, including today. Counts and proposed edits come from the
 * lines. Nothing is written: `applied` stays false, and this function takes
 * no writer.
 */
export function stageRetro(lines: readonly WorkLogLine[], today: string): RetroResult {
  if (!isDay(today)) return empty("The day should look like 2026-11-10.");
  const from = shiftDay(today, -6);
  const week = lines.filter((line) => line.day >= from && line.day <= today);
  const shipped = week.filter((line) => line.kind === "outcome" && starts(line.line, "Done:")).map((line) => line.line);
  const failed = week.filter((line) => line.kind === "outcome" && starts(line.line, "Failed:")).length;
  const sentBack = week.filter((line) => line.kind === "outcome" && starts(line.line, "Sent back:")).length;
  const feedback = week.filter((line) => line.kind === "feedback");
  const counts: RetroCounts = { shipped: shipped.length, failed, sentBack, feedback: feedback.length };

  const pending: PendingEdit[] = [];
  feedback.forEach((line, index) => {
    if (pending.length >= RETRO_EDIT_CAP) return;
    pending.push({
      id: `feedback:${index}`,
      file: "opinions.md",
      title: "A correction from the week",
      text: line.line,
    });
  });
  if (sentBack > 0 && pending.length < RETRO_EDIT_CAP) {
    const times = sentBack === 1 ? "1 time" : `${sentBack} times`;
    pending.push({
      id: "sent-back",
      file: "opinions.md",
      title: "Work sent back",
      text: `Work was sent back ${times} this week. Check the brief before the next try.`,
    });
  }
  if (failed > 0 && pending.length < RETRO_EDIT_CAP) {
    const tasks = failed === 1 ? "1 task" : `${failed} tasks`;
    pending.push({
      id: "failed",
      file: "opinions.md",
      title: "Failed work",
      text: `${tasks} failed this week. Say what broke, in one line.`,
    });
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
  const ask = [
    `Read the work log from ${from} to ${today}.`,
    "Report what shipped and the patterns with counts.",
    "Propose at most 5 concrete edits. Do not apply them. They stay pending until they are accepted.",
    report,
  ].join("\n");
  return { from, to: today, shipped, counts, report, ask, pending, applied: false };
}

/**
 * The learn store's accept is the only writer. The retro does not call this.
 * A caller passes the existing accept, and only after the person accepts one edit.
 */
export function acceptEdit(edit: PendingEdit, apply: (edit: PendingEdit) => void): void {
  apply(edit);
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
