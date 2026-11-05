// WP-70: the shared task list, as an agent sees it. The wording of a task is data, never an instruction.

import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { TaskText } from "../../phases/model/phasePrompt";
import { copyProjects, readKeys, resolveProject, sameProject, type CopyProject } from "../../chief/model/reads";
import { scopeOpen } from "../../chief/model/scope";

/** The FIELDS entries. Not the delegation tools (those task ids are a different thing). */
export const TASK_STORE_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["tasks.list", ["project"]],
  ["tasks.get", ["id", "project"]],
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

const NOT_THIS = "That project isn't this chat's.";
const NOT_COPY = "Not a project on this copy.";
const NOT_FOUND = "No task with that id.";

/** WP-84: how long a phase run waits for the task's words before it starts without them. */
const TASK_TEXT_WAIT_MS = 5_000;
const TASK_TITLE_MAX = 200;
const TASK_DESCRIPTION_MAX = 60_000;

function taskWord(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
}

/** The projects a task read may name: this chat's own, or every project it reads (WP-88), as tasks.get does. */
function readProjects(source: Pick<Session, "id">, host: Pick<AgentAppHost, "codingTeamOf" | "monoOf" | "knownProjects">): string[] {
  try {
    return [taskProjectOf(source, host)];
  } catch {
    const known = copyProjects(host.knownProjects?.());
    const keys: string[] = [];
    for (const project of host.monoOf?.(source.id)?.projects ?? []) {
      if (typeof project !== "string" || !project.trim()) continue;
      const match = resolveProject(project, known);
      keys.push(...(match ? readKeys(match) : [project.trim()]));
    }
    return [...new Set(keys)];
  }
}

function taskWordsOf(found: unknown): TaskText | undefined {
  if (!found || typeof found !== "object" || Array.isArray(found)) return undefined;
  const record = found as Record<string, unknown>;
  const title = taskWord(record.title, TASK_TITLE_MAX);
  const description = taskWord(record.description, TASK_DESCRIPTION_MAX);
  if (!title && !description) return undefined;
  return { title, description };
}

/**
 * WP-84: what a task asks, for a phase worker's brief. The task text is data the worker reads.
 * A store that is missing, slow, unreachable or answers with something else is no words at all:
 * the phase still starts, from the task's id alone.
 */
export async function taskTextFor(
  source: Pick<Session, "id">,
  taskId: string,
  host: Pick<AgentAppHost, "codingTeamOf" | "monoOf" | "knownProjects" | "taskStore">,
  waitMs = TASK_TEXT_WAIT_MS,
): Promise<TaskText | undefined> {
  if (!host.taskStore) return undefined;
  const id = typeof taskId === "string" ? taskId.trim() : "";
  if (!id || id.length > 80) return undefined;
  const store = host.taskStore;
  const read = (async () => {
    try {
      for (const project of readProjects(source, host)) {
        try {
          const words = taskWordsOf(await store("tasks_get", { actor: actorFor(source, project), id }));
          if (words) return words;
        } catch {
          // Another project's key may be the one this task is filed under.
        }
      }
    } catch {
      // A host that cannot even name its projects gives no task text.
    }
    return undefined;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function namedProject(input: Record<string, unknown>, project: string, known: readonly CopyProject[]): void {
  if (input.project === undefined) return;
  if (typeof input.project !== "string" || !sameProject(input.project, project, known)) {
    throw new Error(NOT_THIS);
  }
}

function knownOf(host: AgentAppHost): CopyProject[] {
  return copyProjects(host.knownProjects?.());
}

async function wide(source: Session, host: AgentAppHost): Promise<boolean> {
  const mono = host.monoOf?.(source.id);
  return scopeOpen(mono, mono ? async () => (await host.agentFiles(mono.id)).soul : undefined);
}

function mustKnown(value: unknown, known: readonly CopyProject[]): CopyProject {
  if (typeof value !== "string") throw new Error(NOT_COPY);
  const match = resolveProject(value, known);
  if (!match) throw new Error(NOT_COPY);
  return match;
}

function actorFor(source: Pick<Session, "id">, project: string) {
  return { id: source.id, project, kind: "agent" as const };
}

function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Tasks didn't come back right.");
  return value;
}

function dedupe(lists: unknown[][]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(item);
    }
  }
  return out;
}

function missing(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_FOUND;
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
export async function handleTaskStore(
  source: Session,
  action: StoreAction,
  input: Record<string, unknown>,
  host: AgentAppHost,
): Promise<unknown> {
  if (!host.taskStore) throw new Error("Tasks aren't available in this chat.");
  if (!(await wide(source, host))) {
    const project = taskProjectOf(source, host);
    namedProject(input, project, knownOf(host));
    const actor = actorFor(source, project);
    if (action === "tasks.list") {
      return host.taskStore("tasks_list", { actor, ...(input.project === undefined ? {} : { project: input.project }) });
    }
    if (action === "tasks.get") return host.taskStore("tasks_get", { actor, id: taskId(input.id) });
    return host.taskStore(COMMAND[action], { actor, input });
  }
  const known = knownOf(host);
  // A write still uses this chat's own project. Filing is the one that may name another.
  if (action === "tasks.update") {
    const own = taskProjectOf(source, host);
    namedProject(input, own, known);
    // Create stores the hub id. This chat's own project may also be the folder. Try both, and only for a miss.
    const match = resolveProject(own, known);
    const keys = match ? readKeys(match) : [own];
    for (const project of keys) {
      try {
        return await host.taskStore("tasks_update", { actor: actorFor(source, project), input });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    throw new Error(NOT_FOUND);
  }
  if (action === "tasks.create") {
    const project = input.project === undefined
      ? (resolveProject(taskProjectOf(source, host), known)?.id ?? "")
      : mustKnown(input.project, known).id;
    if (!project || !known.some((item) => item.id === project)) throw new Error(NOT_COPY);
    return host.taskStore("tasks_create", {
      actor: actorFor(source, project),
      input: { ...input, project },
    });
  }
  const projects = input.project === undefined ? known : [mustKnown(input.project, known)];
  const keys = projects.flatMap(readKeys);
  if (action === "tasks.list") {
    const lists = await Promise.all(keys.map((project) => host.taskStore!("tasks_list", { actor: actorFor(source, project) })));
    return dedupe(lists.map(asList));
  }
  let sawMissing = false;
  for (const project of keys) {
    try {
      return await host.taskStore("tasks_get", { actor: actorFor(source, project), id: taskId(input.id) });
    } catch (error) {
      if (!missing(error)) throw error;
      sawMissing = true;
    }
  }
  if (sawMissing || keys.length === 0) throw new Error(NOT_FOUND);
  throw new Error(NOT_FOUND);
}
