// WP-215: one handoff. File the task, then hand it to the project's first mate. No model call.

import { readsEveryProject, type ScopeMono } from "./scope";
import { handoffLine } from "./captain";

export const DEFAULT_DEPARTMENT = "Coding";

export type HandoffMono = ScopeMono & { projects?: readonly string[] };

/** The chief can read a project it is on, or every project when its scope says so. */
export function captainCanRead(mono: HandoffMono | null | undefined, project: string): boolean {
  if (!mono) return false;
  if (readsEveryProject(mono)) return true;
  const wanted = project.trim();
  if (!wanted) return false;
  return (mono.projects ?? []).some((item) => item.trim() === wanted);
}

export type HandoffInput = {
  project: string;
  department?: string;
  title: string;
  brief: string;
};

export type HandoffDeps = {
  canRead: (project: string) => boolean;
  createTask: (task: { project: string; title: string; brief: string }) => Promise<{ id: string }>;
  delegate: (task: { project: string; title: string; brief: string; department: string; taskId: string }) => Promise<{ id: string }>;
};

export type HandoffResult = {
  taskId: string;
  delegationId: string;
  department: string;
  line: string;
};

function required(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} is empty.`);
  return text;
}

/**
 * Files the task first, then hands it on, and answers with both ids.
 * An unreadable project is refused before anything is filed.
 */
export async function captainHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffResult> {
  const project = required(input.project, "The project");
  const title = required(input.title, "The title");
  const brief = required(input.brief, "The brief");
  const department = input.department?.trim() || DEFAULT_DEPARTMENT;
  if (!deps.canRead(project)) throw new Error("The Chief of Staff cannot read that project.");
  const filed = await deps.createTask({ project, title, brief });
  const taskId = required(filed?.id ?? "", "The filed task");
  const handed = await deps.delegate({ project, title, brief, department, taskId });
  const delegationId = required(handed?.id ?? "", "The handoff");
  return { taskId, delegationId, department, line: handoffLine(department, title) };
}

/** The id `tasks_create` returns lives on the task, not on the wrapper. */
export function filedTaskId(created: unknown): string {
  const task = created && typeof created === "object" ? (created as { task?: { id?: unknown } }).task : undefined;
  const id = task && typeof task.id === "string" ? task.id.trim() : "";
  if (!id) throw new Error("The task was not filed.");
  return id;
}

/** The delegation id, or the child chat when the row has no id of its own. */
export function delegationId(created: unknown): string {
  if (!created || typeof created !== "object") throw new Error("The handoff was not started.");
  const row = created as { taskId?: unknown; childSessionId?: unknown };
  const id =
    typeof row.taskId === "string" && row.taskId.trim()
      ? row.taskId.trim()
      : typeof row.childSessionId === "string"
        ? row.childSessionId.trim()
        : "";
  if (!id) throw new Error("The handoff was not started.");
  return id;
}
