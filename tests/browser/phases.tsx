import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { begin, counter, finishRun, running } from "../../src/features/phases/model/machine";
import { seedWork, setPhaseCrew } from "../../src/features/phases/model/store";
import { TaskPane } from "../../src/features/tasks/ui/TaskPane";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-84. The real task pane, with a phased task waiting after research.
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

const ids = counter();
let work = begin("task-4", { weight: "costly" }, {}, ids);
work = finishRun(work, work.version, running(work)!.id, { body: "Which line does the save drop?" }, ids).work;
work = finishRun(work, work.version, running(work)!.id, { body: "Research found the save drops the last line." }, ids).work;
seedWork(work);
setPhaseCrew((run) => ({ body: run.phase === "design" ? "Keep the last line in the file." : `Notes for ${run.phase}.` }));

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => [{ id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder", folder: PROJECT }];
setHubDataSource(src);

installFakeTauri("phases", (command, args) => {
  const actor = args.actor as { project?: string } | undefined;
  if (command === "tasks_list") return tasks.filter((task) => task.projectId === actor?.project);
  if (command === "tasks_get") {
    const task = tasks.find((item) => item.id === args.id);
    if (!task) throw new Error("No task with that id.");
    return task;
  }
  throw new Error(`unexpected ${command}`);
});

createRoot(document.getElementById("root")!).render(<TaskPane project={PROJECT} />);
