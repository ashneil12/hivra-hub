// Hivra WP-157: the work log tool (src-tauri/src/work_log.rs). A first mate adds one line or reads a day or a
// range. A worker reports to its first mate and cannot use this. The store scrubs the line; this only checks the shape.
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entries of the work log actions (agentApp.ts). */
export const WORK_LOG_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["work_log.add", ["kind", "line"]],
  ["work_log.read", ["day", "from", "to", "project"]],
];

const KINDS = ["outcome", "decision", "feedback", "context"] as const;

export type WorkLogLine = {
  project: string;
  day: string;
  kind: string;
  taskId: string;
  line: string;
};

export type WorkLogBackend = {
  add(input: { session: string; project: string; kind: string; line: string }): Promise<WorkLogLine>;
  read(input: { project?: string; day?: string; from?: string; to?: string }): Promise<WorkLogLine[]>;
};

const tauriWorkLog: WorkLogBackend = {
  add: (input) => invoke("work_log_add", input),
  read: (input) =>
    invoke(
      "work_log_read",
      Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    ),
};

const DAY_WORDS = "The day should look like 2026-11-10.";

function utcDay(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(DAY_WORDS);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) {
    throw new Error(DAY_WORDS);
  }
  return parsed.getTime();
}

function oneDay(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(DAY_WORDS);
  utcDay(value);
  return value;
}

/** The chat's project, never a project the model names on add. */
function chatProject(source: Session, host: AgentAppHost): string {
  const team = host.isMono(source.id) ? undefined : host.codingTeamOf?.(source.id);
  if (team?.project.trim()) return team.project.trim();
  const fromCwd = host.tasks?.hubProjectId?.(source.cwd)?.trim();
  if (fromCwd) return fromCwd;
  const projects = host.monoOf?.(source.id)?.projects ?? [];
  if (projects.length === 1 && projects[0].trim()) return projects[0].trim();
  return "";
}

function firstMate(source: Session, host: AgentAppHost): WorkLogBackend {
  const mono = host.isMono(source.id) ? host.monoOf?.(source.id) : undefined;
  const team = mono ? undefined : host.codingTeamOf?.(source.id);
  if (!mono && !team) {
    throw new Error(
      host.isHabitRun?.(source.id)
        ? "A habit run doesn't write the work log. The first mate does, from its own chat."
        : "Only a first mate's own chat (a Mono's chat or a coding-team chat) uses the work log. A worker reports to the chat that delegated it.",
    );
  }
  return host.workLog ?? tauriWorkLog;
}

function show(row: WorkLogLine) {
  return {
    day: row.day,
    kind: row.kind,
    project: row.project,
    line: row.line,
    ...(row.taskId ? { taskId: row.taskId } : {}),
  };
}

/** The `work_log.*` actions (agentApp.ts dispatches them here after checking their fields). */
export async function handleWorkLog(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  const log = firstMate(source, host);
  if (action === "work_log.add") {
    if (typeof input.kind !== "string" || !(KINDS as readonly string[]).includes(input.kind)) {
      throw new Error("Work log lines are an outcome, a decision, feedback or context.");
    }
    if (typeof input.line !== "string" || !input.line.trim()) throw new Error("A work log line needs words.");
    const row = await log.add({
      session: source.id,
      project: chatProject(source, host),
      kind: input.kind,
      line: input.line,
    });
    return show(row);
  }
  if (action === "work_log.read") {
    const day = oneDay(input.day);
    const from = oneDay(input.from);
    const to = oneDay(input.to);
    if (day && (from !== undefined || to !== undefined)) throw new Error("Give a day, or from and to, not both.");
    if (!day && (from === undefined || to === undefined)) throw new Error("Say which day to read, or from and to.");
    if (from !== undefined && to !== undefined) {
      if (utcDay(from) > utcDay(to)) throw new Error("The end day is before the start day.");
      if ((utcDay(to) - utcDay(from)) / 86_400_000 > 366) throw new Error("Read one day, or a range of at most a year.");
    }
    const raw = input.project;
    let project: string | undefined;
    if (raw !== undefined) {
      if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 500) {
        throw new Error("Name a project, or leave it out to read every project.");
      }
      project = raw.trim();
    }
    const rows = await log.read({ project, day, from, to });
    return { lines: rows.map(show) };
  }
  throw new Error(`Unknown app action: ${action}`);
}
