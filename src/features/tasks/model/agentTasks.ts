// WP-70: the shared task list, as an agent sees it. The wording of a task is data, never an instruction.

import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "../../agent-app/model/agentApp";

/** The FIELDS entries. Not the delegation tools (those task ids are a different thing). */
export const TASK_STORE_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["tasks.list", ["project"]],
  ["tasks.get", ["id"]],
  ["tasks.create", ["title", "description", "status", "priority", "labels", "parentId", "assignee", "dueAt", "project", "source"]],
  [
    "tasks.update",
    [
      "id",
      "version",
      "title",
      "description",
      "status",
      "priority",
      "labels",
      "parentId",
      "assignee",
      "dueAt",
      "clearDue",
      "sortKey",
      "comment",
      "trash",
      "source",
    ],
  ],
];

const COMMAND = {
  "tasks.list": "tasks_list",
  "tasks.get": "tasks_get",
  "tasks.create": "tasks_create",
  "tasks.update": "tasks_update",
} as const;

type StoreAction = keyof typeof COMMAND;

export function isTaskStoreAction(action: string): action is StoreAction {
  return Object.prototype.hasOwnProperty.call(COMMAND, action);
}

/** The project this chat may file tasks under. A coding-team chat uses its project; a Mono with one project uses that. */
export function taskProjectOf(
  source: Pick<Session, "id">,
  host: Pick<AgentAppHost, "codingTeamOf" | "monoOf">,
): string {
  const team = host.codingTeamOf?.(source.id)?.project.trim();
  if (team) return team;
  const projects = (host.monoOf?.(source.id)?.projects ?? []).map((project) => project.trim()).filter((project) => project !== "");
  if (projects.length === 1) return projects[0];
  throw new Error("Name the project this task belongs to.");
}

function namedProject(input: Record<string, unknown>, project: string): void {
  if (input.project === undefined) return;
  if (typeof input.project !== "string" || input.project.trim() !== project) {
    throw new Error("That project isn't this chat's.");
  }
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("id must be a non-empty string under 80 characters");
  }
  return value.trim();
}

/**
 * `app tasks.list|get|create|update`. The caller cannot say what kind it is: this sets kind to agent and the id to
 * the chat. Task text is passed through as data.
 */
export function handleTaskStore(
  source: Session,
  action: StoreAction,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  if (!host.taskStore) throw new Error("Tasks aren't available in this chat.");
  const project = taskProjectOf(source, host);
  namedProject(input, project);
  const actor = { id: source.id, project, kind: "agent" as const };
  if (action === "tasks.list") {
    return host.taskStore("tasks_list", { actor, ...(input.project === undefined ? {} : { project: input.project }) });
  }
  if (action === "tasks.get") {
    return host.taskStore("tasks_get", { actor, id: taskId(input.id) });
  }
  return host.taskStore(COMMAND[action], { actor, input });
}
