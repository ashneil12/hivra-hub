// A task from the store, which may be missing fields, becomes the task shape Orbit's view helpers read.
// Status ids are the status names: tasks_update looks a status up by name.

import type { StatusCategory, Task, TaskPriority, TaskStatusDef } from "../vendor/models";
import type { LabelRecord, ProjectRecord } from "../vendor/records";
import type { TaskPatch } from "../vendor/views/layoutGroups";

const PRIORITIES = new Set<TaskPriority>(["none", "low", "medium", "high", "urgent"]);
const CATEGORIES = new Set<StatusCategory>(["unstarted", "started", "completed", "cancelled", "duplicate"]);

export const STATUS_NAMES = ["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"] as const;

const FALLBACK_CATEGORY: Record<(typeof STATUS_NAMES)[number], StatusCategory> = {
  Backlog: "unstarted",
  Todo: "unstarted",
  "In progress": "started",
  "In review": "started",
  Done: "completed",
  Cancelled: "cancelled",
};

export type StoreComment = { id: string; body: string };
export type StoreActivity = { id: string; text: string };

export type StoreTask = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  parentId: string | null;
  assignee: string | null;
  dueAt: number | null;
  sortKey: string;
  version: number;
  createdBy: string;
  delegationId: string | null;
  needsYou: boolean;
  failed: boolean;
  createdAt: number;
  updatedAt: number;
  comments: StoreComment[];
  activity: StoreActivity[];
  cli: string | null;
  workingSince: number | null;
  finishedAt: number | null;
  chatId: string | null;
  githubUrl: string | null;
  githubPaused: boolean;
  githubPulls: { title: string; url: string; state: string }[];
};

export function isAgentTask(task: Pick<StoreTask, "delegationId">): boolean {
  return task.delegationId != null && task.delegationId !== "";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function whole(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function githubPulls(value: unknown): { title: string; url: string; state: string }[] {
  if (!Array.isArray(value)) return [];
  const pulls: { title: string; url: string; state: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || row.url.trim() === "") continue;
    pulls.push({
      title: typeof row.title === "string" ? row.title : "",
      url: row.url.trim(),
      state: typeof row.state === "string" ? row.state : "",
    });
  }
  return pulls;
}

function notes<T extends { id: string }>(value: unknown, field: "body" | "text"): T[] {
  if (!Array.isArray(value)) return [];
  const notes: T[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row[field] !== "string") continue;
    notes.push({ id: row.id, [field]: row[field] } as T);
  }
  return notes;
}

/** One task from disk or another window. A row without an id and a title is dropped. */
export function readStoreTask(value: unknown): StoreTask | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.trim() === "" || typeof row.title !== "string") return null;
  return {
    id: row.id,
    projectId: text(row.projectId),
    number: whole(row.number),
    title: row.title,
    description: text(row.description),
    status: text(row.status, "Backlog"),
    priority: text(row.priority, "none"),
    labels: texts(row.labels),
    parentId: typeof row.parentId === "string" && row.parentId !== "" ? row.parentId : null,
    assignee: typeof row.assignee === "string" && row.assignee !== "" ? row.assignee : null,
    dueAt: typeof row.dueAt === "number" && Number.isFinite(row.dueAt) ? row.dueAt : null,
    sortKey: text(row.sortKey),
    version: whole(row.version),
    createdBy: text(row.createdBy),
    delegationId: typeof row.delegationId === "string" && row.delegationId !== "" ? row.delegationId : null,
    needsYou: row.needsYou === true,
    failed: row.failed === true,
    createdAt: whole(row.createdAt),
    updatedAt: whole(row.updatedAt),
    comments: notes<StoreComment>(row.comments, "body"),
    activity: notes<StoreActivity>(row.activity, "text"),
    cli: typeof row.cli === "string" && row.cli.trim() !== "" ? row.cli.trim() : null,
    workingSince: typeof row.workingSince === "number" && Number.isFinite(row.workingSince) ? row.workingSince : null,
    finishedAt: typeof row.finishedAt === "number" && Number.isFinite(row.finishedAt) ? row.finishedAt : null,
    chatId: typeof row.chatId === "string" && row.chatId.trim() !== "" ? row.chatId.trim() : null,
    githubUrl: typeof row.githubUrl === "string" && row.githubUrl.trim() !== "" ? row.githubUrl.trim() : null,
    githubPaused: row.githubPaused === true,
    githubPulls: githubPulls(row.githubPulls),
  };
}

export function readStoreTasks(value: unknown): StoreTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: StoreTask[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const task = readStoreTask(item);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

function categoryOf(name: string, fromServer: string | undefined): StatusCategory {
  if (fromServer && CATEGORIES.has(fromServer as StatusCategory)) return fromServer as StatusCategory;
  if (name in FALLBACK_CATEGORY) return FALLBACK_CATEGORY[name as (typeof STATUS_NAMES)[number]];
  return "unstarted";
}

export function fallbackStatuses(projectId: string): TaskStatusDef[] {
  return STATUS_NAMES.map((name, position) => ({
    id: name,
    projectId,
    name,
    description: "",
    color: "",
    category: FALLBACK_CATEGORY[name],
    position,
    version: 1,
  }));
}

/**
 * Status rows from the command. A bad row is skipped, and so is a row for a project that was not asked for.
 * None left means the default workflow for those projects, not another project's statuses.
 */
export function readStatuses(value: unknown, projectIds: readonly string[]): TaskStatusDef[] {
  const allowed = new Set(projectIds.filter((id) => id !== ""));
  const defs: TaskStatusDef[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = text(row.name);
      const projectId = text(row.projectId);
      if (name === "" || projectId === "" || !allowed.has(projectId)) continue;
      defs.push({
        id: name,
        projectId,
        name,
        description: "",
        color: text(row.color),
        category: categoryOf(name, text(row.category)),
        position: whole(row.position),
        version: 1,
      });
    }
  }
  if (defs.length > 0) return defs;
  const ids = [...allowed];
  return (ids.length > 0 ? ids : [""]).flatMap((projectId) => fallbackStatuses(projectId));
}

function iso(millis: number | null): string | null {
  if (millis == null || !Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function priorityOf(value: string): TaskPriority {
  return PRIORITIES.has(value as TaskPriority) ? (value as TaskPriority) : "none";
}

function agentWork(task: StoreTask): boolean {
  return isAgentTask(task) || task.cli != null || task.workingSince != null || task.finishedAt != null;
}

export function toOrbitTasks(tasks: readonly StoreTask[], statuses: readonly TaskStatusDef[], now: number): Task[] {
  const category = new Map(statuses.map((status) => [`${status.projectId}:${status.name}`, status.category]));
  const ordered = [...tasks].sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.number - b.number);
  return ordered.map((task, index) => {
    const children = ordered.filter((item) => item.parentId === task.id);
    const closed = children.filter((child) => {
      const kind = category.get(`${child.projectId}:${child.status}`);
      return kind === "completed" || kind === "cancelled";
    });
    const agent = agentWork(task);
    const taskForOrbit: Task = {
      id: task.id,
      identifier: `#${task.number}`,
      number: task.number,
      title: task.title,
      description: task.description,
      statusId: task.status,
      position: index,
      priority: priorityOf(task.priority),
      assigneeIds: task.assignee ? [task.assignee] : [],
      creatorId: task.createdBy || undefined,
      projectId: task.projectId,
      labels: task.labels,
      attachments: [],
      dueStartAt: agent ? iso(task.createdAt || task.workingSince) : null,
      dueAt: agent ? iso(task.finishedAt ?? (task.workingSince != null || isAgentTask(task) ? now : task.updatedAt || null)) : iso(task.dueAt),
      createdAt: iso(task.createdAt) ?? new Date(0).toISOString(),
      updatedAt: iso(task.updatedAt) ?? new Date(0).toISOString(),
      comments: [],
      activity: [],
      parentTaskId: task.parentId,
      subIssueCount: children.length,
      subIssueClosedCount: closed.length,
      version: task.version,
    };
    return taskForOrbit;
  });
}

export function membersOf(tasks: readonly StoreTask[]): { id: string; name: string }[] {
  const ids = new Set<string>();
  for (const task of tasks) if (task.assignee) ids.add(task.assignee);
  return [...ids].map((id) => ({ id, name: id }));
}

export function labelsOf(tasks: readonly StoreTask[]): LabelRecord[] {
  const seen = new Set<string>();
  const labels: LabelRecord[] = [];
  for (const task of tasks) {
    for (const name of task.labels) {
      const key = `${task.projectId}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ id: name, name, color: "", version: 1, workspace_id: "", project_id: task.projectId });
    }
  }
  return labels;
}

export function projectsOf(ids: readonly string[]): ProjectRecord[] {
  return [...new Set(ids.filter((id) => id !== ""))].map((id) => ({
    id,
    name: id,
    key: id.slice(0, 8),
    color: "",
    workspace_id: "",
    version: 1,
    created_at: "",
    updated_at: "",
    auto_close_parent: false,
    auto_close_sub_issues: false,
  }));
}

/** Orbit's patch uses status ids and assignee lists. Hivra stores one status name and one assignee. */
export function hivraFields(patch: TaskPatch): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (patch.status_id !== undefined) input.status = patch.status_id;
  if (patch.priority !== undefined) input.priority = patch.priority;
  if (patch.assignee_ids !== undefined) input.assignee = patch.assignee_ids[0] ?? null;
  if (patch.label_ids !== undefined) input.labels = patch.label_ids;
  return input;
}
