// What Home lists. One line each, no counts. A value from disk or another agent is untrusted.

import { pathKey } from "../../../shared/lib/paths";
import { HOME_CARD_LIMIT } from "../vendor/homeLayout";

export type HomeTask = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  source: string;
  assignee: string | null;
  needsYou: boolean;
  trashedAt: number | null;
  createdAt: number;
};

export type HomeDecision = {
  project: string;
  decisionKey: string;
  question: string;
  state: string;
  createdAt: number;
};

export type HomeDoc = {
  id: string;
  title: string;
  lastOpenedAt: number | null;
  trashedAt: number | null;
};

export type HomeChat = {
  id: string;
  title: string;
  projectId: string;
  openedAt: number;
};

export type HomeLineKind = "decision" | "question" | "review" | "moving" | "doc" | "chat" | "builders" | "project" | "stopped";

export type HomeLine = {
  id: string;
  kind: HomeLineKind;
  text: string;
  projectId: string;
  /** Person-facing project name for a Needs you chip. Absent on other lines. */
  projectName?: string;
  target: string;
  at: number;
  /** At most two, primary first. A line with any is not itself a button. */
  actions?: readonly { label: string; run: () => void }[];
};

export type HomeProject = { id: string; name: string; folder: string | null };

const REVIEW = "In review";
const MOVING = "In progress";
const NO_ONE = "No one yet";

/** One visible line. Carriage returns and blank runs are not a second line. */
export function cleanLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").replace(/[ \t\f\v]+/g, " ").trim();
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseTask(raw: unknown): HomeTask | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  return {
    id,
    projectId: typeof rec.projectId === "string" ? rec.projectId : "",
    title: typeof rec.title === "string" ? cleanLine(rec.title) : "",
    status: typeof rec.status === "string" ? rec.status.trim() : "",
    source: typeof rec.source === "string" ? rec.source.trim() : "",
    assignee: typeof rec.assignee === "string" ? rec.assignee : null,
    needsYou: rec.needsYou === true,
    trashedAt: finite(rec.trashedAt),
    createdAt: finite(rec.createdAt) ?? 0,
  };
}

export function parseDecision(raw: unknown): HomeDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const project = typeof rec.project === "string" ? rec.project : "";
  const decisionKey = typeof rec.decisionKey === "string" ? rec.decisionKey.trim() : "";
  if (!decisionKey) return null;
  return {
    project,
    decisionKey,
    question: typeof rec.question === "string" ? cleanLine(rec.question) : "",
    state: typeof rec.state === "string" ? rec.state : "",
    createdAt: finite(rec.createdAt) ?? 0,
  };
}

export function parseDoc(raw: unknown): HomeDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  return {
    id,
    title: typeof rec.title === "string" ? cleanLine(rec.title) : "",
    lastOpenedAt: finite(rec.lastOpenedAt),
    trashedAt: finite(rec.trashedAt),
  };
}

export function parseChat(raw: unknown): HomeChat | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id || /[\\/\0]|\.\./.test(id)) return null;
  const openedAt = finite(rec.openedAt);
  if (openedAt == null) return null;
  const title = typeof rec.title === "string" ? cleanLine(rec.title) : "";
  return {
    id,
    title: title || "Untitled",
    projectId: typeof rec.projectId === "string" ? rec.projectId : "",
    openedAt,
  };
}

export function sanitizeProjects(raw: unknown): HomeProject[] {
  if (!Array.isArray(raw)) return [];
  const out: HomeProject[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof rec.name === "string" ? cleanLine(rec.name) : "";
    const folder = typeof rec.folder === "string" && rec.folder.trim() ? rec.folder : null;
    out.push({ id, name: name || id, folder });
  }
  return out;
}

/** Hub id for a task filed under the id or under the folder, including a Windows path. The path is not rewritten. */
export function hubProjectId(projectId: string, projects: readonly HomeProject[]): string {
  const key = projectId.trim();
  if (!key) return projectId;
  const hit = projects.find((project) => project.id === key || (project.folder != null && pathKey(project.folder) === pathKey(key)));
  return hit?.id ?? projectId;
}

export function namesFor(projects: readonly HomeProject[]): (projectId: string) => string {
  const byKey = new Map<string, string>();
  for (const project of projects) {
    if (!byKey.has(project.id)) byKey.set(project.id, project.name);
    if (project.folder && !byKey.has(pathKey(project.folder))) byKey.set(pathKey(project.folder), project.name);
  }
  return (projectId: string) => {
    const named = byKey.get(projectId) ?? (projectId.trim() ? byKey.get(pathKey(projectId)) : undefined);
    return named && named.trim() ? named : projectId.trim() || "Project";
  };
}

/** Every key a task may be filed under. The folder is read as stored, so ".." and a Windows path stay as written. */
export function taskReadKeys(projects: readonly HomeProject[]): string[] {
  const read: string[] = [];
  for (const project of projects) {
    for (const id of [project.id, project.folder ?? ""]) {
      if (id !== "" && !read.includes(id)) read.push(id);
    }
  }
  return read;
}

function byAge(a: HomeLine, b: HomeLine): number {
  return a.at - b.at || a.id.localeCompare(b.id);
}

function lineOf(projectId: string, text: string, name: (id: string) => string): string {
  const project = cleanLine(name(projectId)) || "Project";
  return `${project} · ${text}`;
}

/**
 * Open decisions, tasks waiting in review, and tasks flagged as a question.
 * A task that is both a question and in review is one review line. Oldest first.
 */
export function needsYouLines(
  decisions: readonly HomeDecision[],
  tasks: readonly HomeTask[],
  name: (projectId: string) => string,
): HomeLine[] {
  const lines: HomeLine[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (decision.state !== "open") continue;
    const question = cleanLine(decision.question);
    if (!question) continue;
    const id = `decision:${decision.project}:${decision.decisionKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push({
      id,
      kind: "decision",
      text: lineOf(decision.project, question, name),
      projectId: decision.project,
      target: decision.decisionKey,
      at: decision.createdAt,
    });
  }
  for (const task of tasks) {
    const title = cleanLine(task.title);
    if (task.trashedAt != null || !title) continue;
    const review = task.status === REVIEW;
    const question = task.needsYou && !review;
    if (!review && !question) continue;
    const id = `task:${task.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push({
      id,
      kind: review ? "review" : "question",
      text: lineOf(task.projectId, title, name),
      projectId: task.projectId,
      target: task.id,
      at: task.createdAt,
    });
  }
  lines.sort(byAge);
  return lines;
}

/**
 * WP-161: new builders are waiting on the disk pause. A line about the machine, not a project, so it has no project
 * name in front. It leads Needs you: nothing new can start until the person frees space (or changes the floor).
 * Its action opens Settings > Worktrees > Clean up (`targetFor`).
 */
export function builderHoldLine(need: { id: string; text: string }): HomeLine {
  return {
    id: `builders:${need.id}`,
    kind: "builders",
    text: cleanLine(need.text),
    projectId: "",
    target: need.id,
    at: 0,
  };
}

/** Agent tasks in progress, except a question (that line is in Needs you). */
export function movingLines(tasks: readonly HomeTask[], name: (projectId: string) => string): HomeLine[] {
  const lines: HomeLine[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const title = cleanLine(task.title);
    if (task.trashedAt != null || !title) continue;
    if (task.source !== "agent" || task.status !== MOVING || task.needsYou) continue;
    const id = `task:${task.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const who = cleanLine(task.assignee ?? "") || NO_ONE;
    lines.push({
      id,
      kind: "moving",
      text: `${lineOf(task.projectId, title, name)} · ${who}`,
      projectId: task.projectId,
      target: task.id,
      at: task.createdAt,
    });
  }
  lines.sort(byAge);
  return lines;
}

/** The last few docs and chats the person opened. Newest first, capped at Orbit's card limit. */
export function recentLines(docs: readonly HomeDoc[], chats: readonly HomeChat[]): HomeLine[] {
  const lines: HomeLine[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (doc.trashedAt != null || doc.lastOpenedAt == null) continue;
    const id = `doc:${doc.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push({
      id,
      kind: "doc",
      text: cleanLine(doc.title) || "Untitled",
      projectId: "",
      target: doc.id,
      at: doc.lastOpenedAt,
    });
  }
  for (const chat of chats) {
    if (!chat.id || chat.openedAt == null || !Number.isFinite(chat.openedAt)) continue;
    const id = `chat:${chat.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push({
      id,
      kind: "chat",
      text: cleanLine(chat.title) || "Untitled",
      projectId: chat.projectId,
      target: chat.id,
      at: chat.openedAt,
    });
  }
  lines.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return lines.slice(0, HOME_CARD_LIMIT);
}

/**
 * One line per project, in the strip's order: its name, then what is happening there in a few words.
 * Needs you items on that project become a count from the same list ("Hivra · 2 need you"). Otherwise the first
 * task moving in it, or just the name. The builder hold is not one of the items.
 */
export function projectLines(
  projects: readonly HomeProject[],
  needsYou: readonly HomeLine[],
  moving: readonly HomeLine[],
  tasks: readonly HomeTask[],
): HomeLine[] {
  const lines: HomeLine[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    const name = cleanLine(project.name) || project.id;
    const count = needsYou.filter((line) => line.projectId === project.id && line.kind !== "builders").length;
    let what = "";
    if (count > 0) {
      what = count === 1 ? "1 needs you" : `${count} need you`;
    } else {
      const line = moving.find((item) => item.projectId === project.id);
      const task = line ? tasks.find((item) => `task:${item.id}` === line.id) : undefined;
      if (task) what = cleanLine(task.title);
    }
    lines.push({
      id: `project:${project.id}`,
      kind: "project",
      text: what ? `${name} · ${what}` : name,
      projectId: project.id,
      target: project.id,
      at: 0,
    });
  }
  return lines;
}
