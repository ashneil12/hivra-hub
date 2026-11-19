// WP-157: the work log a person reads. Days and kinds, and the answer to
// "what got done today?" from those lines. Nothing here writes the log.

export const KINDS = ["outcome", "decision", "feedback", "context"] as const;

export type WorkLogKind = (typeof KINDS)[number];

export type WorkLogLine = {
  project: string;
  day: string;
  kind: WorkLogKind;
  taskId: string;
  line: string;
};

export const KIND_LABEL: Record<WorkLogKind, string> = {
  outcome: "Outcomes",
  decision: "Decisions",
  feedback: "Feedback",
  context: "Context",
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day, `2026-11-10`. Anything else is not a day. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** The calendar day where `now` is, not UTC. */
export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Move a calendar day by whole days. A bad day is returned unchanged. */
export function shiftDay(day: string, delta: number): string {
  if (!isDay(day) || !Number.isFinite(delta)) return day;
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + delta);
  const nextMonth = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const nextDate = String(utc.getUTCDate()).padStart(2, "0");
  return `${utc.getUTCFullYear()}-${nextMonth}-${nextDate}`;
}

/** The question the log answers. A wider sentence is left for the chat. */
export function isTodayQuestion(text: string): boolean {
  return /^\s*what got done today\s*[?.!]*\s*$/i.test(text);
}

/** Today's outcome lines, in the order they were written. Other kinds are not "got done". */
export function todayAnswer(lines: readonly WorkLogLine[], day: string): string {
  const done = lines.filter((row) => row.day === day && row.kind === "outcome");
  if (done.length === 0) return "Nothing got done today.";
  return done.map((row) => row.line).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function oneLine(value: unknown): WorkLogLine | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.project !== "string" || typeof row.day !== "string" || typeof row.line !== "string") return null;
  if (!isDay(row.day) || !KINDS.includes(row.kind as WorkLogKind)) return null;
  const line = row.line.trim();
  if (!line) return null;
  const project = row.project.trim();
  if (!project) return null;
  const taskId = typeof row.taskId === "string" ? row.taskId : "";
  return { project, day: row.day, kind: row.kind as WorkLogKind, taskId, line };
}

/** Rows from disk or the app are untrusted. A bad row is left out, not thrown. */
export function readLines(raw: unknown): WorkLogLine[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkLogLine[] = [];
  for (const row of raw) {
    const line = oneLine(row);
    if (line) out.push(line);
  }
  return out;
}

export type KindGroup = { kind: WorkLogKind; label: string; lines: WorkLogLine[] };

export type DayGroup = { day: string; kinds: KindGroup[] };

/**
 * Newest day first, and inside a day the kinds in a fixed order.
 * A blank project is every project. A name matches the whole project, not a prefix.
 */
export function groupLines(lines: readonly WorkLogLine[], project?: string): DayGroup[] {
  const want = project?.trim() ?? "";
  const kept = readLines(lines).filter((row) => !want || row.project === want);
  const byDay = new Map<string, WorkLogLine[]>();
  for (const row of kept) {
    const list = byDay.get(row.day);
    if (list) list.push(row);
    else byDay.set(row.day, [row]);
  }
  const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return days.map((day) => ({
    day,
    kinds: KINDS.map((kind) => ({
      kind,
      label: KIND_LABEL[kind],
      lines: (byDay.get(day) ?? []).filter((row) => row.kind === kind),
    })).filter((group) => group.lines.length > 0),
  }));
}

/**
 * When the chat asks what got done today, the reply is the log's lines.
 * A read that fails leaves the question as it was. An empty log is not the same thing.
 */
export async function withTodayAnswer(text: string, now = new Date()): Promise<string> {
  if (!isTodayQuestion(text)) return text;
  const day = localDay(now);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke("work_log_read", { day });
    const answer = todayAnswer(readLines(rows), day);
    return `${text}\n\nAnswer from the work log, not from memory.\n${answer}`;
  } catch {
    return text;
  }
}
