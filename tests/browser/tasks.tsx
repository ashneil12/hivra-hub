import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { TaskPane } from "../../src/features/tasks/ui/TaskPane";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-70. The real task pane the crew mounts. This page only answers the commands it already calls.
const PROJECT = "/work/proj";

type Task = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: string;
  status: string;
  needsYou: boolean;
  failed: boolean;
  assignee: string | null;
  version: number;
  comments: { id: string; body: string }[];
  activity: { id: string; text: string }[];
};

const tasks: Task[] = [
  {
    id: "task-4",
    projectId: "crew",
    number: 4,
    title: "Fix the save",
    description: "The save drops the last line.",
    status: "In progress",
    needsYou: true,
    failed: false,
    assignee: "mate-1",
    version: 1,
    comments: [],
    activity: [{ id: "a1", text: "recorded" }],
  },
];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [
  { id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder", folder: PROJECT },
];
setHubDataSource(src);

installFakeTauri("tasks", (command, args) => {
  const actor = args.actor as { project?: string } | undefined;
  if (command === "tasks_list") {
    return tasks.filter((task) => task.projectId === actor?.project);
  }
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
      needsYou: false,
      failed: false,
      assignee: input.assignee ? input.assignee : null,
      version: 1,
      comments: [],
      activity: [],
    };
    tasks.push(task);
    return { stale: false, task };
  }
  if (command === "tasks_update") {
    const input = args.input as { id: string; comment?: string; status?: string; assignee?: string | null };
    const task = tasks.find((item) => item.id === input.id);
    if (!task) throw new Error("No task with that id.");
    if (input.comment) task.comments.push({ id: `c-${task.comments.length}`, body: input.comment });
    if (input.status) task.status = input.status;
    if ("assignee" in input) task.assignee = input.assignee ?? null;
    task.version += 1;
    return { stale: false, task };
  }
  throw new Error(`unexpected ${command}`);
});

createRoot(document.getElementById("root")!).render(<TaskPane project={PROJECT} />);
