// Turn the app's own records into the board. Missing cost, time or checks stay missing.

import { pathKey } from "../../../shared/lib/paths";
import { boardChipCounts } from "./counts";
import { costUsdBySession, type CostSession } from "./cost";
import { agentsBoardSessionStopReady } from "./sessionStop";
import { buildAgentsTree, type BoardNode, type BoardPerson, type BoardProject } from "./tree";
import { boardState } from "./words";

export type StoreProject = { id: string; name: string; folder?: string | null };

export type StoreSession = {
  id: string;
  title?: string | null;
  projectId?: string | null;
  place?: "home" | "project" | "subchat" | null;
  parentSessionId?: string | null;
  status?: string | null;
  state?: string | null;
  task?: string | null;
  startedAt?: number | null;
  settledAt?: number | null;
};

export type StoreMate = {
  id: string;
  name: string;
  projectId: string;
  sessionId?: string | null;
  department?: string | null;
  status?: string | null;
  state?: string | null;
  task?: string | null;
  startedAt?: number | null;
};

export type StoreDelegation = {
  id: string;
  title?: string | null;
  project?: string | null;
  ownerMono?: string | null;
  ownerSession?: string | null;
  parentId?: string | null;
  childSession?: string | null;
  status?: string | null;
  state?: string | null;
  createdAt?: number | null;
  startedAt?: number | null;
  settledAt?: number | null;
  brief?: string | null;
};

export type StoreCheck = {
  delegationId?: string | null;
  sessionId?: string | null;
  prNumber?: number | null;
  failing?: number;
  pending?: number;
  passed?: boolean;
};

export type BoardSource = {
  now: number;
  projects: readonly StoreProject[];
  sessions: readonly StoreSession[];
  mates: readonly StoreMate[];
  delegations: readonly StoreDelegation[];
  checks: readonly StoreCheck[];
  costs: readonly CostSession[];
};

function projectIdOf(value: string | null | undefined, projects: readonly StoreProject[]): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;
  const byId = projects.find((project) => project.id === text);
  if (byId) return byId.id;
  let key = "";
  try {
    key = pathKey(text);
  } catch {
    key = text;
  }
  const byFolder = projects.find((project) => {
    if (!project.folder) return false;
    try {
      return pathKey(project.folder) === key;
    } catch {
      return project.folder === text;
    }
  });
  return byFolder?.id ?? null;
}

function checkFor(id: string, sessionId: string | null, checks: readonly StoreCheck[]): StoreCheck | undefined {
  return checks.find((check) => check.delegationId === id || (sessionId && check.sessionId === sessionId));
}

/** A first mate is Working while its own chat runs a turn, not only when a worker under it does. */
export function mateStatus(
  sessionId: string | null | undefined,
  sessions: readonly { id: string; busy?: boolean }[],
): "working" | "idle" {
  if (!sessionId) return "idle";
  return sessions.some((session) => session.id === sessionId && session.busy === true) ? "working" : "idle";
}

const FINISHED_STATUS = new Set(["failed", "done"]);
const FINISHED_STATE = new Set(["failed", "cancelled", "stopped", "completed", "done"]);

/**
 * Stop only while the work is still going. The status chip can say Needs you for a failure,
 * but a failed or finished worker has nothing left to stop. The status is the one to read;
 * an older row with no status falls back to its state.
 */
function workerCanStop(row: { ownerSession?: string | null; status?: string | null; state?: string | null }): boolean {
  if (!row.ownerSession?.trim()) return false;
  const status = (row.status ?? "").trim().toLowerCase();
  const raw = (row.state ?? "").trim().toLowerCase();
  if (FINISHED_STATUS.has(status)) return false;
  if (!status && FINISHED_STATE.has(raw)) return false;
  const state = boardState(row);
  return state === "working" || state === "needs-you";
}

/** A project chat, home chat or sub-chat can be stopped only while it is working and the app lent its Stop. */
function sessionCanStop(status: string | null | undefined): boolean {
  return boardState({ status }) === "working" && agentsBoardSessionStopReady();
}

export function boardFromStores(source: BoardSource): {
  tree: BoardNode;
  projects: BoardProject[];
  counts: { needsYou: number; working: number };
} {
  const projects: BoardProject[] = [];
  const seenProject = new Set<string>();
  for (const project of source.projects) {
    if (!project || typeof project.id !== "string" || !project.id || seenProject.has(project.id)) continue;
    seenProject.add(project.id);
    projects.push({ id: project.id, name: project.name ?? "", folder: project.folder ?? null });
  }
  const costs = costUsdBySession(source.costs);
  const delegationIds = new Set(source.delegations.map((row) => row.id));
  const people: BoardPerson[] = [
    { id: "captain", role: "captain", name: "Chief of Staff", state: "idle" },
  ];

  for (const session of source.sessions) {
    if (!session?.id || session.place === "subchat") continue;
    if (session.place !== "home" && session.place !== "project") continue;
    const projectId = session.place === "project" ? projectIdOf(session.projectId, projects) : null;
    people.push({
      id: session.id,
      role: session.place,
      name: session.title?.trim() || (session.place === "home" ? "Home" : ""),
      projectId,
      parentId: "captain",
      state: boardState(session),
      task: session.task,
      startedAt: session.startedAt,
      settledAt: session.settledAt,
      costUsd: costs.get(session.id) ?? null,
      sessionId: session.id,
      canStop: sessionCanStop(session.status),
    });
  }

  for (const mate of source.mates) {
    if (!mate?.id || !mate.projectId) continue;
    people.push({
      id: mate.id,
      role: "mate",
      name: mate.name,
      projectId: mate.projectId,
      department: mate.department ?? "coding",
      state: boardState(mate),
      task: mate.task,
      startedAt: mate.startedAt,
      sessionId: mate.sessionId ?? null,
      costUsd: mate.sessionId ? costs.get(mate.sessionId) ?? null : null,
    });
  }

  const workerBySession = new Map<string, string>();
  for (const row of source.delegations) {
    if (!row?.id) continue;
    const projectId = projectIdOf(row.project, projects);
    const mate =
      source.mates.find((item) => row.ownerMono && item.id === row.ownerMono) ??
      source.mates.find((item) => row.ownerSession && item.sessionId && item.sessionId === row.ownerSession) ??
      source.mates.find((item) => projectId && item.projectId === projectId);
    const nested = row.parentId && delegationIds.has(row.parentId) ? row.parentId : null;
    const sessionId = row.childSession?.trim() || null;
    if (sessionId) workerBySession.set(sessionId, row.id);
    const check = checkFor(row.id, sessionId, source.checks);
    const state = boardState(row);
    people.push({
      id: row.id,
      role: "worker",
      name: row.title?.trim() || "Untitled work",
      projectId,
      parentId: nested ?? mate?.id ?? null,
      state,
      task: row.brief,
      startedAt: typeof row.startedAt === "number" ? row.startedAt : row.createdAt,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
      costUsd: sessionId ? costs.get(sessionId) ?? null : null,
      sessionId,
      prNumber: check?.prNumber ?? null,
      checks: check ? { failing: check.failing, pending: check.pending, passed: check.passed } : null,
      canStop: workerCanStop(row),
    });
  }

  for (const session of source.sessions) {
    if (!session?.id || session.place !== "subchat") continue;
    const parentSession = session.parentSessionId?.trim();
    people.push({
      id: session.id,
      role: "subchat",
      name: session.title?.trim() || "Sub-chat",
      projectId: projectIdOf(session.projectId, projects),
      parentId: (parentSession && workerBySession.get(parentSession)) || parentSession || null,
      state: boardState(session),
      task: session.task,
      startedAt: session.startedAt,
      settledAt: session.settledAt,
      costUsd: costs.get(session.id) ?? null,
      sessionId: session.id,
      canStop: sessionCanStop(session.status),
    });
  }

  const tree = buildAgentsTree({ projects, people, now: source.now });
  return {
    tree,
    projects,
    counts: boardChipCounts(tree, null, source.now),
  };
}
