// WP-159: the programme a first mate keeps. Not the per-job worker queue.
// A worker is refused here, before the store is called. Parked rows stay parked until the person clears them.

import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { copyProjects, resolveProject, sameProject } from "../../chief/model/reads";

export const PROGRAMME_CHANGED = "programme://changed";

export const WORKER_REASON =
  "Only the first mate can change the programme. You are a worker here: tell your first mate what to queue, in your report.";

const HABIT = "A habit run can't change the programme. The first mate does that from its own chat.";
const CHECKER = "The checker only reads. It never changes the programme.";
const NOT_THIS = "That project isn't this chat's.";
const NAME_PROJECT = "Name the project this programme belongs to.";
const UNAVAILABLE = "The programme isn't available in this chat.";
const NOT_COPY = "Not a project on this copy.";

export const PROGRAMME_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["programme.list", ["project"]],
  ["programme.enqueue", ["wp", "title", "briefPath", "branch", "priority", "notes", "securityPark", "project"]],
  ["programme.set_status", ["id", "version", "status", "project"]],
  ["programme.park", ["id", "version", "reason", "security", "project"]],
];

const COMMAND = {
  "programme.list": "programme_list",
  "programme.enqueue": "programme_enqueue",
  "programme.set_status": "programme_set_status",
  "programme.park": "programme_park",
} as const;

type StoreAction = keyof typeof COMMAND;

export function isProgrammeAction(action: string): action is StoreAction {
  return Object.prototype.hasOwnProperty.call(COMMAND, action);
}

export type ProgrammeStatus = "queued" | "building" | "pr_open" | "merged" | "parked" | "failed";

export type ProgrammePackage = {
  id: string;
  projectId: string;
  wp: string;
  title: string;
  briefPath: string;
  branch: string;
  status: ProgrammeStatus;
  securityPark: boolean;
  priority: number;
  notes: string;
  parkReason: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  finishedAt: number | null;
};

const STATUSES: ReadonlySet<string> = new Set(["queued", "building", "pr_open", "merged", "parked", "failed"]);

/** Length in characters (code points), not UTF-16 units: an emoji is one character here. */
export function textLength(value: string): number {
  return [...value].length;
}

/** Clips a text for display only. The row keeps its full text. */
export function clipText(value: string, max: number): string {
  if (textLength(value) <= max) return value;
  return [...value].slice(0, Math.max(0, max - 1)).join("") + "\u2026";
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\0/g, "");
  if (!clean.trim()) return undefined;
  return clean;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalWhole(value: unknown): number | null | undefined {
  if (value === null) return null;
  return whole(value);
}

/** A row from the store or from disk. Anything else is dropped. */
export function readPackage(value: unknown): ProgrammePackage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  // A row the store wrote is kept whatever its length. The display clips; nothing here drops a long row.
  const id = text(row.id);
  const projectId = text(row.projectId);
  const wp = text(row.wp);
  const title = text(row.title);
  const briefPath = text(row.briefPath);
  const branch = text(row.branch);
  const status = typeof row.status === "string" && STATUSES.has(row.status) ? (row.status as ProgrammeStatus) : undefined;
  const priority = whole(row.priority);
  const version = whole(row.version);
  const createdAt = whole(row.createdAt);
  const updatedAt = whole(row.updatedAt);
  const claimedAt = optionalWhole(row.claimedAt);
  const finishedAt = optionalWhole(row.finishedAt);
  if (!id || !projectId || !wp || !title || !briefPath || !branch || !status) return undefined;
  if (priority === undefined || version === undefined || createdAt === undefined || updatedAt === undefined) return undefined;
  if (claimedAt === undefined || finishedAt === undefined) return undefined;
  if (typeof row.securityPark !== "boolean") return undefined;
  const notes = typeof row.notes === "string" ? row.notes.replace(/\0/g, "") : "";
  const parkReason = row.parkReason === null ? null : row.parkReason === undefined ? null : text(row.parkReason);
  if (row.parkReason != null && parkReason === undefined) return undefined;
  return {
    id,
    projectId,
    wp,
    title,
    briefPath,
    branch,
    status,
    securityPark: row.securityPark,
    priority,
    notes,
    parkReason: parkReason ?? null,
    version,
    createdAt,
    updatedAt,
    claimedAt,
    finishedAt,
  };
}

export type ProgrammeGroup = "queued" | "flight" | "parked" | "failed";

/** Merged rows are done. A security park sits with the parked rows even if the status has not moved yet. */
export function programmeGroup(row: ProgrammePackage): ProgrammeGroup | undefined {
  if (row.status === "merged") return undefined;
  if (row.status === "parked" || row.securityPark) return "parked";
  if (row.status === "building" || row.status === "pr_open") return "flight";
  if (row.status === "queued") return "queued";
  if (row.status === "failed") return "failed";
  return undefined;
}

/** Rows that came back from the boards read, and the projects whose board did not (a throw or a non-list). */
export type ProgrammeLoad = { rows: ProgrammePackage[]; failed: string[] } | { unavailable: true };

/** Retries back off from five seconds to a minute. */
export const PROGRAMME_RETRY_MS = 5_000;
const RETRY_CAP_MS = 60_000;
/** After this many failed reads in a row, the card says so in plain words. */
export const READ_NOTICE_AFTER = 3;
export const READ_NOTICE = "The programme could not be read. It will keep trying.";

export function retryDelayMs(failures: number): number {
  const steps = Math.max(0, Math.min(failures - 1, 20));
  return Math.min(RETRY_CAP_MS, PROGRAMME_RETRY_MS * 2 ** steps);
}

function byPriority(a: ProgrammePackage, b: ProgrammePackage): number {
  return b.priority - a.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * A late read is dropped. A board that failed keeps the rows it had (`previous`), and the rest are shown as read.
 * `noticeAt` is the read that a notice was set by: only a later, complete read clears that notice.
 */
export function applyProgrammeLoad(
  mine: number,
  current: number,
  loaded: ProgrammeLoad,
  previous: readonly ProgrammePackage[] = [],
  noticeAt = -1,
): { rows: ProgrammePackage[]; retry: boolean; clearNotice: boolean } | { drop: true } {
  if (mine !== current) return { drop: true };
  if ("unavailable" in loaded) return { rows: [...previous].sort(byPriority), retry: true, clearNotice: false };
  const failed = new Set(loaded.failed);
  const kept = previous.filter((row) => failed.has(row.projectId));
  const retry = loaded.failed.length > 0;
  return {
    rows: [...loaded.rows, ...kept].sort(byPriority),
    retry,
    clearNotice: !retry && mine > noticeAt,
  };
}

/**
 * One read of every project's board, each on its own. One board that throws or does not answer with a list is
 * recorded in `failed`; the others still come back. Only a read where every board failed is `unavailable`.
 */
export async function collectProgramme(
  projects: readonly string[],
  read: (project: string) => Promise<unknown>,
): Promise<ProgrammeLoad> {
  const settled = await Promise.allSettled(projects.map(async (project) => read(project)));
  const rows: ProgrammePackage[] = [];
  const failed: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected" || !Array.isArray(result.value)) {
      failed.push(projects[index]);
      return;
    }
    for (const item of result.value) {
      const row = readPackage(item);
      if (row) rows.push(row);
    }
  });
  if (projects.length > 0 && failed.length === projects.length) return { unavailable: true };
  return { rows: rows.sort(byPriority), failed };
}

/** The rows the card shows: merged rows are done and are not shown. */
export function shownRows(rows: readonly ProgrammePackage[]): ProgrammePackage[] {
  return rows.filter((row) => programmeGroup(row) !== undefined);
}

/** The card shows when a row sits in a group it shows, or when a notice is set. A quiet board renders nothing. */
export function programmeShows(rows: readonly ProgrammePackage[], notice?: string): boolean {
  return shownRows(rows).length > 0 || !!notice;
}

type MateHost = Pick<AgentAppHost, "isMono" | "isHabitRun" | "monoOf" | "codingTeamOf" | "knownProjects" | "programmeStore">;

function ownProjects(source: Pick<Session, "id">, host: MateHost): string[] {
  return (host.monoOf?.(source.id)?.projects ?? []).map((project) => project.trim()).filter((project) => project !== "");
}

function mateProject(source: Session, host: MateHost, named: unknown): string {
  if (host.monoOf?.(source.id)?.id === CHECKER_MONO_ID) throw new Error(CHECKER);
  if (host.isHabitRun?.(source.id)) throw new Error(HABIT);
  const own = host.isMono(source.id) && !host.isHabitRun?.(source.id);
  const team = own ? undefined : host.codingTeamOf?.(source.id);
  if (!own && !team) throw new Error(WORKER_REASON);
  if (team) {
    if (named !== undefined && named !== team.project) throw new Error(NOT_THIS);
    return team.project;
  }
  const projects = ownProjects(source, host);
  const known = copyProjects(host.knownProjects?.());
  let mine: string;
  if (named === undefined) {
    if (projects.length !== 1) throw new Error(NAME_PROJECT);
    mine = projects[0];
  } else {
    const match = typeof named === "string" ? projects.find((project) => sameProject(named, project, known)) : undefined;
    if (!match) throw new Error(NOT_THIS);
    mine = match;
  }
  // A Mono names its projects by folder. The board is filed under the hub project id, the one Home reads.
  const project = resolveProject(mine, known);
  if (!project) throw new Error(NOT_COPY);
  return project.id;
}

function idOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || textLength(value) > 80) throw new Error("id is required.");
  return value.trim();
}

function versionOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("version is required.");
  return value;
}

function copy(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/**
 * `app programme.list|enqueue|set_status|park`. The caller cannot say what kind it is.
 * A worker, a habit run and the checker never reach the store.
 */
export async function handleProgramme(
  source: Session,
  action: StoreAction,
  input: Record<string, unknown>,
  host: MateHost,
): Promise<unknown> {
  if (!host.programmeStore) throw new Error(UNAVAILABLE);
  const project = mateProject(source, host, input.project);
  const actor = { id: source.id, project, kind: "first-mate" as const };
  if (action === "programme.list") return host.programmeStore("programme_list", { actor });
  if (action === "programme.enqueue") {
    return host.programmeStore("programme_enqueue", {
      actor,
      input: copy(input, ["wp", "title", "briefPath", "branch", "priority", "notes", "securityPark"]),
    });
  }
  const id = idOf(input.id);
  const version = versionOf(input.version);
  if (action === "programme.set_status") {
    if (typeof input.status !== "string" || !input.status.trim()) throw new Error("status is required.");
    return host.programmeStore("programme_set_status", { actor, input: { id, version, status: input.status } });
  }
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new Error("reason is required.");
  return host.programmeStore("programme_park", {
    actor,
    input: { id, version, reason: input.reason, ...(input.security === undefined ? {} : { security: input.security }) },
  });
}
