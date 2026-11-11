// WP-215: one handoff. File the task, then hand it to the project's first mate. No model call.

import { readsEveryProject, scopeOpen, type ScopeMono } from "./scope";
import { handoffLine } from "./captain";

export const DEFAULT_DEPARTMENT = "Coding";

export type HandoffMono = ScopeMono & { projects?: readonly string[] };

function onProjectList(mono: HandoffMono, project: string): boolean {
  const wanted = project.trim();
  if (!wanted) return false;
  return (mono.projects ?? []).some((item) => item.trim() === wanted);
}

/**
 * The chief can read a project it is on, or every project when its scope says so.
 * The soul file counts when the roster copy does not carry the line (`scopeOpen`).
 * Without a soul reader this stays synchronous, the same check as before.
 */
export function captainCanRead(
  mono: HandoffMono | null | undefined,
  project: string,
  readSoul?: () => Promise<string | null | undefined>,
): boolean | Promise<boolean> {
  if (!mono) return false;
  const listed = onProjectList(mono, project);
  if (!readSoul) return readsEveryProject(mono) || listed;
  return scopeOpen(mono, readSoul).then((open) => open || listed);
}

/**
 * The finish condition, not a second copy of the brief.
 * The title is the condition when it says something the brief does not.
 */
export function handoffGoal(title: string, brief: string): string {
  const name = title.trim();
  const words = brief.trim();
  if (name && name !== words) return `Done when ${name}. The check for it passes, and the report says what changed.`;
  return "Done when the change is in, the check the brief names passes, and the report says what changed.";
}

export type HandoffInput = {
  project: string;
  department?: string;
  title: string;
  brief: string;
};

export type HandoffDeps = {
  canRead: (project: string) => boolean | Promise<boolean>;
  createTask: (task: { project: string; title: string; brief: string }) => Promise<{ id: string }>;
  delegate: (task: { project: string; title: string; brief: string; department: string; taskId: string }) => Promise<{ id: string }>;
  /** A task already filed for this same handoff, so a retry does not file another. */
  recall?(key: string): string | undefined;
  remember?(key: string, taskId: string): void;
  forget?(key: string): void;
};

/** One handoff, whatever request id the retry uses. */
export function handoffRequestKey(input: { project: string; department: string; title: string; brief: string }): string {
  return `${input.project}\n${input.department}\n${input.title}\n${input.brief}`;
}

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
  if (!(await deps.canRead(project))) throw new Error("The Chief of Staff cannot read that project.");
  const key = handoffRequestKey({ project, department, title, brief });
  let taskId = deps.recall?.(key);
  if (!taskId) {
    const filed = await deps.createTask({ project, title, brief });
    taskId = required(filed?.id ?? "", "The filed task");
    deps.remember?.(key, taskId);
  }
  try {
    const handed = await deps.delegate({ project, title, brief, department, taskId });
    const delegationId = required(handed?.id ?? "", "The handoff");
    deps.forget?.(key);
    return { taskId, delegationId, department, line: handoffLine(department, title) };
  } catch (error) {
    // The filed id stays remembered, so the retry hands that task on instead of filing another.
    throw error;
  }
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
