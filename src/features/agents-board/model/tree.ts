// The Agents board tree: captain, home, one project session, first mates, crew, sub-chats.

import {
  checksLabel,
  costLabel,
  prNumberOf,
  rowName,
  taskWords,
  timeLabel,
} from "./words";

export type BoardRole = "captain" | "home" | "project" | "mate" | "worker" | "subchat";
export type BoardState = "needs-you" | "working" | "done" | "idle";

export type BoardChecks = { failing?: number; pending?: number; passed?: boolean };

export type BoardPerson = {
  id: string;
  role: BoardRole;
  name: string;
  projectId?: string | null;
  parentId?: string | null;
  state: BoardState;
  task?: string | null;
  costUsd?: number | null;
  startedAt?: number | null;
  settledAt?: number | null;
  createdAt?: number | null;
  prNumber?: number | null;
  checks?: BoardChecks | null;
  sessionId?: string | null;
  canStop?: boolean;
  department?: string | null;
};

export type BoardProject = { id: string; name: string; folder?: string | null };

export type BoardNode = {
  id: string;
  role: BoardRole;
  name: string;
  projectId: string | null;
  state: BoardState;
  task: string | null;
  costLabel: string | null;
  timeLabel: string | null;
  prNumber: number | null;
  checksLabel: string | null;
  sessionId: string | null;
  canStop: boolean;
  settledAt: number | null;
  createdAt: number | null;
  /** The row's own state, before a child makes the chip stronger. */
  ownState: BoardState;
  /** True when the chip is only there because a row under it is stronger. */
  rolledUp: boolean;
  children: BoardNode[];
};

const RANK: Record<BoardRole, number> = {
  captain: 0,
  home: 1,
  project: 2,
  mate: 3,
  worker: 4,
  subchat: 5,
};

function blank(person: BoardPerson, name: string, projectId: string | null, now: number): BoardNode {
  return {
    id: person.id,
    role: person.role,
    name,
    projectId,
    state: person.state,
    task: taskWords(person.task),
    costLabel: costLabel(person.costUsd),
    timeLabel: timeLabel(person.startedAt, now),
    prNumber: prNumberOf(person.prNumber),
    checksLabel: checksLabel(person.checks),
    sessionId: person.sessionId?.trim() || null,
    canStop: person.canStop === true,
    settledAt: typeof person.settledAt === "number" && Number.isFinite(person.settledAt) ? person.settledAt : null,
    createdAt: typeof person.createdAt === "number" && Number.isFinite(person.createdAt) ? person.createdAt : null,
    ownState: person.state,
    rolledUp: false,
    children: [],
  };
}

function projectTitle(project: BoardProject): string | null {
  const name = rowName("worker", project.name, null, null);
  return name === "Untitled" ? null : name;
}

function dedupe(people: readonly BoardPerson[]): BoardPerson[] {
  const byId = new Map<string, BoardPerson>();
  for (const person of people) {
    if (!person || typeof person.id !== "string" || !person.id.trim()) continue;
    const id = person.id.trim();
    const prev = byId.get(id);
    if (!prev || RANK[person.role] < RANK[prev.role]) byId.set(id, { ...person, id });
  }
  const seenSession = new Set<string>();
  const out: BoardPerson[] = [];
  for (const person of [...byId.values()].sort((a, b) => RANK[a.role] - RANK[b.role] || a.id.localeCompare(b.id))) {
    const sessionId = person.sessionId?.trim();
    if (sessionId) {
      if (seenSession.has(sessionId)) continue;
      seenSession.add(sessionId);
    }
    out.push(person);
  }
  return out;
}

function present(person: BoardPerson, projects: ReadonlyMap<string, BoardProject>, now: number): BoardNode {
  const project = person.projectId ? projects.get(person.projectId) : undefined;
  const projectName = project ? projectTitle(project) : null;
  return blank(
    person,
    rowName(person.role, person.name, projectName, person.department ?? null),
    person.projectId ?? null,
    now,
  );
}

function compareMates(a: BoardPerson, b: BoardPerson): number {
  const rank = (person: BoardPerson) => {
    const dept = (person.department ?? person.name).trim().toLowerCase();
    return dept === "coding" || dept.startsWith("coding") ? 0 : 1;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function sortCrew(node: BoardNode): void {
  const mates = node.children.filter((child) => child.role === "mate");
  const rest = node.children.filter((child) => child.role !== "mate");
  rest.sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || a.id.localeCompare(b.id));
  node.children = [...mates, ...rest];
  node.children.forEach(sortCrew);
}

export function buildAgentsTree(input: {
  projects: readonly BoardProject[];
  people: readonly BoardPerson[];
  now: number;
}): BoardNode {
  const projects = new Map<string, BoardProject>();
  for (const project of input.projects) {
    if (!project || typeof project.id !== "string" || !project.id.trim()) continue;
    if (!projects.has(project.id)) projects.set(project.id, project);
  }
  const people = dedupe(input.people);
  const now = input.now;
  const captainPerson = people.find((person) => person.role === "captain");
  const captain = present(
    captainPerson ?? { id: "captain", role: "captain", name: "Chief of Staff", state: "idle" },
    projects,
    now,
  );
  const used = new Set<string>([captain.id]);
  const take = (person: BoardPerson): BoardNode | null => {
    if (used.has(person.id)) return null;
    used.add(person.id);
    return present(person, projects, now);
  };

  const homes = people.filter((person) => person.role === "home").flatMap((person) => {
    const node = take(person);
    return node ? [node] : [];
  });

  const wanted = new Set<string>();
  for (const person of people) {
    if (person.role === "captain" || person.role === "home") continue;
    if (person.projectId && projects.has(person.projectId)) wanted.add(person.projectId);
  }
  const projectNodes: BoardNode[] = [];
  for (const project of projects.values()) {
    if (!wanted.has(project.id)) continue;
    const session = people.find((person) => person.role === "project" && person.projectId === project.id);
    const node = session ? take(session) : null;
    if (node) {
      projectNodes.push(node);
      continue;
    }
    const id = `project:${project.id}`;
    if (used.has(id)) continue;
    used.add(id);
    const name = projectTitle(project) ?? "Untitled";
    projectNodes.push({
      id,
      role: "project",
      name,
      projectId: project.id,
      state: "idle",
      task: null,
      costLabel: null,
      timeLabel: null,
      prNumber: null,
      checksLabel: null,
      sessionId: null,
      canStop: false,
      settledAt: null,
      createdAt: null,
      ownState: "idle",
      rolledUp: false,
      children: [],
    });
  }

  const index = new Map<string, BoardNode>();
  const watch = (node: BoardNode) => {
    index.set(node.id, node);
    if (node.sessionId) index.set(`session:${node.sessionId}`, node);
  };
  watch(captain);
  homes.forEach(watch);
  projectNodes.forEach(watch);

  for (const projectNode of projectNodes) {
    const mates = people
      .filter((person) => person.role === "mate" && person.projectId === projectNode.projectId)
      .sort(compareMates);
    for (const mate of mates) {
      const node = take(mate);
      if (!node) continue;
      projectNode.children.push(node);
      watch(node);
    }
  }

  const rest = people.filter((person) => (person.role === "worker" || person.role === "subchat") && !used.has(person.id));
  let pending = rest;
  for (let guard = 0; pending.length && guard < rest.length + 1; guard++) {
    const next: BoardPerson[] = [];
    for (const person of pending) {
      const parent =
        (person.parentId && (index.get(person.parentId) ?? index.get(`session:${person.parentId}`))) || null;
      if (!parent) {
        next.push(person);
        continue;
      }
      const node = take(person);
      if (!node) continue;
      parent.children.push(node);
      watch(node);
    }
    if (next.length === pending.length) {
      for (const person of next) {
        const project = projectNodes.find((node) => node.projectId && node.projectId === person.projectId);
        if (!project) continue;
        const node = take(person);
        if (!node) continue;
        project.children.push(node);
        watch(node);
      }
      break;
    }
    pending = next;
  }

  for (const project of projectNodes) sortCrew(project);
  captain.children = [...homes, ...projectNodes];
  rollupStates(captain);
  return captain;
}

const STATE_RANK: Record<BoardState, number> = {
  "needs-you": 0,
  working: 1,
  done: 2,
  idle: 3,
};

/** Every level, the top included, shows Needs you, then Working, then Done or Idle. */
function rollupStates(node: BoardNode): void {
  for (const child of node.children) rollupStates(child);
  let state = node.ownState;
  for (const child of node.children) {
    if (STATE_RANK[child.state] < STATE_RANK[state]) state = child.state;
  }
  node.rolledUp = STATE_RANK[state] < STATE_RANK[node.ownState];
  node.state = state;
}

export function flattenBoard(node: BoardNode): BoardNode[] {
  return [node, ...node.children.flatMap(flattenBoard)];
}

/** Rows under this one whose own state is `state`, not a state they only repeat. */
export function descendantOwnCount(node: BoardNode, state: BoardState): number {
  let count = 0;
  for (const child of node.children) {
    if (child.ownState === state) count += 1;
    count += descendantOwnCount(child, state);
  }
  return count;
}
