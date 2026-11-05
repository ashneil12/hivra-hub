import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { TaskPane } from "../../src/features/tasks/ui/TaskPane";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-71. The same task pane, with saved views kept in this page's own storage so a reload still has them.
const PROJECT = "/work/proj";
const VIEWS = "hivra-wp71-views";

type Task = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  assignee: string | null;
  sortKey: string;
  version: number;
  needsYou: boolean;
  failed: boolean;
  comments: { id: string; body: string }[];
  activity: { id: string; text: string }[];
  delegationId: string | null;
  cli: string | null;
  workingSince: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  chatId: string | null;
  dueAt: number | null;
};

type View = { id: string; pageKey: string; name: string; state: unknown; version: number; builtin: boolean };

const tasks: Task[] = [
  {
    id: "task-1",
    projectId: "crew",
    number: 1,
    title: "Write the notes",
    description: "Notes",
    status: "Todo",
    priority: "none",
    labels: ["Notes"],
    assignee: "ada",
    sortKey: "00000001",
    version: 1,
    needsYou: false,
    failed: false,
    comments: [],
    activity: [],
    delegationId: null,
    cli: null,
    workingSince: null,
    finishedAt: null,
    createdAt: Date.parse("2026-03-01T00:00:00Z"),
    updatedAt: Date.parse("2026-03-01T00:00:00Z"),
    chatId: null,
    dueAt: null,
  },
  {
    id: "task-2",
    projectId: "crew",
    number: 2,
    title: "Fix the save",
    description: "",
    status: "Todo",
    priority: "high",
    labels: [],
    assignee: null,
    sortKey: "00000002",
    version: 1,
    needsYou: false,
    failed: false,
    comments: [],
    activity: [],
    delegationId: null,
    cli: null,
    workingSince: null,
    finishedAt: null,
    createdAt: Date.parse("2026-03-01T00:00:00Z"),
    updatedAt: Date.parse("2026-03-01T00:00:00Z"),
    chatId: null,
    dueAt: null,
  },
  {
    id: "agent-1",
    projectId: "crew",
    number: 3,
    title: "Ship the board",
    description: "Agent work",
    status: "In progress",
    priority: "none",
    labels: [],
    assignee: "claude",
    sortKey: "00000003",
    version: 1,
    needsYou: false,
    failed: false,
    comments: [],
    activity: [],
    delegationId: "del-1",
    cli: "claude",
    workingSince: Date.parse("2026-03-02T00:00:00Z"),
    finishedAt: null,
    createdAt: Date.parse("2026-03-01T00:00:00Z"),
    updatedAt: Date.parse("2026-03-02T00:00:00Z"),
    chatId: "chat-1",
    dueAt: null,
  },
];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [{ id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder", folder: PROJECT }];
setHubDataSource(src);

function storedViews(): View[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEWS) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as View[]) : [];
  } catch {
    return [];
  }
}

function writeViews(views: View[]) {
  localStorage.setItem(VIEWS, JSON.stringify(views));
}

function viewsFor(pageKey: string): View[] {
  const views = storedViews().filter((view) => view.pageKey === pageKey);
  if (views.some((view) => view.builtin)) return views;
  const builtin: View = {
    id: `default:${pageKey}`,
    pageKey,
    name: "Tasks",
    state: {
      filter: { op: "and", children: [] },
      display: {
        layout: "list",
        group_by: "status",
        sub_group_by: "none",
        order_by: "manual",
        order_direction: "asc",
        properties: ["id", "status", "assignee", "priority", "labels", "sub_issue_progress"],
        show_completed: "all",
        show_empty_groups: false,
        sub_issues: "nested",
      },
    },
    version: 1,
    builtin: true,
  };
  const next = [builtin, ...views];
  writeViews([...storedViews().filter((view) => view.pageKey !== pageKey), ...next]);
  return next;
}

const STATUSES = [
  { name: "Backlog", category: "unstarted", position: 0 },
  { name: "Todo", category: "unstarted", position: 1 },
  { name: "In progress", category: "started", position: 0 },
  { name: "In review", category: "started", position: 1 },
  { name: "Done", category: "completed", position: 0 },
  { name: "Cancelled", category: "cancelled", position: 0 },
];

const tauri = installFakeTauri("boards", (command, args) => {
  const actor = args.actor as { project?: string } | undefined;
  if (command === "tasks_list") return tasks.filter((task) => task.projectId === actor?.project);
  if (command === "tasks_get") {
    const task = tasks.find((item) => item.id === args.id);
    if (!task) throw new Error("No task with that id.");
    return task;
  }
  if (command === "tasks_create") {
    const input = args.input as { title: string; assignee?: string };
    const task: Task = {
      id: `task-${tasks.length + 1}`,
      projectId: "crew",
      number: tasks.length + 1,
      title: input.title,
      description: "",
      status: "Backlog",
      priority: "none",
      labels: [],
      assignee: input.assignee ? input.assignee : null,
      sortKey: String(tasks.length + 1).padStart(8, "0"),
      version: 1,
      needsYou: false,
      failed: false,
      comments: [],
      activity: [],
      delegationId: null,
      cli: null,
      workingSince: null,
      finishedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chatId: null,
      dueAt: null,
    };
    tasks.push(task);
    return { stale: false, task };
  }
  if (command === "tasks_update") {
    const input = args.input as {
      id: string;
      version?: number;
      comment?: string;
      status?: string;
      priority?: string;
      assignee?: string | null;
      labels?: string[];
      sort_key?: string;
    };
    const task = tasks.find((item) => item.id === input.id);
    if (!task) throw new Error("No task with that id.");
    if (typeof input.version === "number" && input.version !== task.version) return { stale: true, task };
    if (task.delegationId && input.status && input.status !== task.status) throw new Error("This task follows its work.");
    if (input.comment) task.comments.push({ id: `c-${task.comments.length}`, body: input.comment });
    if (input.status) task.status = input.status;
    if (input.priority) task.priority = input.priority;
    if ("assignee" in input) task.assignee = input.assignee ?? null;
    if (input.labels) task.labels = input.labels;
    if (input.sort_key) task.sortKey = input.sort_key;
    task.version += 1;
    return { stale: false, task };
  }
  if (command === "tasks_statuses") {
    return STATUSES.map((status) => ({ id: status.name, projectId: "crew", ...status, color: "" }));
  }
  if (command === "tasks_views_list") {
    return viewsFor(String(args.pageKey ?? ""));
  }
  if (command === "tasks_views_save") {
    const input = args.input as { pageKey: string; id?: string; name?: string; state?: unknown; version?: number };
    const views = viewsFor(input.pageKey);
    if (!input.id) {
      const view: View = { id: `view-${views.length + 1}`, pageKey: input.pageKey, name: input.name || "View", state: input.state, version: 1, builtin: false };
      writeViews([...storedViews(), view]);
      return { stale: false, view };
    }
    const view = views.find((item) => item.id === input.id);
    if (!view) throw new Error("No view with that id.");
    if (typeof input.version === "number" && input.version !== view.version) return { stale: true, view };
    view.state = input.state;
    view.version += 1;
    writeViews(storedViews().map((item) => (item.id === view.id ? view : item)));
    return { stale: false, view };
  }
  if (command === "tasks_views_delete") {
    const view = storedViews().find((item) => item.id === args.id);
    if (!view) throw new Error("No view with that id.");
    if (view.builtin) throw new Error("The default view stays.");
    writeViews(storedViews().filter((item) => item.id !== view.id));
    return { stale: false, view };
  }
  throw new Error(`unexpected ${command}`);
});

window.__hivraMove = (id: string, status: string) => {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  task.status = status;
  task.version += 1;
  if (status === "Done" || status === "Cancelled") {
    task.finishedAt = Date.parse("2026-03-05T00:00:00Z");
    task.workingSince = null;
  } else {
    task.workingSince = task.workingSince ?? Date.parse("2026-03-02T00:00:00Z");
    task.finishedAt = null;
  }
  tauri.emit("tasks://changed", { ids: [id] });
};

createRoot(document.getElementById("root")!).render(<TaskPane project={PROJECT} />);
