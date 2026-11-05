// WP-73. The real strip and the real Home. This page only answers the commands they already call.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { setHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { setHomeOpener } from "../../src/features/home/model/opener";
import { HomeView } from "../../src/features/home/ui/HomeView";
import { ProjectStrip } from "../../src/features/hub/ui/ProjectStrip";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const empty = new URLSearchParams(location.search).has("empty");
const HUB_KEY = "wp73-home-hub";

type Row = Record<string, unknown>;

const tasks: Row[] = empty ? [] : [
  { id: "font", projectId: "crew", title: "Which font?", status: "In progress", source: "person", assignee: null, needsYou: true, trashedAt: null, createdAt: 20 },
  { id: "spec", projectId: "crew", title: "Read the spec", status: "In review", source: "agent", assignee: "Ada", needsYou: true, trashedAt: null, createdAt: 30 },
  { id: "write", projectId: "crew", title: "Write the notes", status: "In progress", source: "agent", assignee: "Ada", needsYou: false, trashedAt: null, createdAt: 40 },
];

const decisions: Row[] = empty ? [] : [
  { project: "crew", decisionKey: "ship", question: "Should we ship?", state: "open", createdAt: 10 },
];

const docs: Row[] = empty ? [] : [
  { id: "plan", title: "Plan", lastOpenedAt: 100, trashedAt: null },
];

const seed = {
  arrangement: {
    order: [
      { kind: "builtin", id: "needs-you" },
      { kind: "builtin", id: "moving-now" },
      { kind: "builtin", id: "recent" },
    ],
    hidden: [],
    savedAt: 1,
  },
  recent: empty ? [] : [{ id: "c1", title: "Lead chat", projectId: "crew", openedAt: 90 }],
  savedAt: 1,
};

function stored(): { value: unknown; rev: number } {
  const raw = localStorage.getItem(HUB_KEY);
  if (!raw) return { value: seed, rev: 1 };
  try {
    const parsed = JSON.parse(raw) as { value?: unknown; rev?: unknown };
    return { value: parsed.value ?? null, rev: typeof parsed.rev === "number" ? parsed.rev : 0 };
  } catch {
    return { value: null, rev: 0 };
  }
}

const projects = [
  { id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder" as const, folder: "C:\\work\\crew" },
  { id: "notes", name: "Notes", shortName: "Notes", iconShape: "folder" as const, folder: null },
];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => projects;
setHubDataSource(src);
setHubSelection({ project: "crew", item: "home" });

const fake = installFakeTauri("home", (command, args) => {
  if (command === "tasks_list") {
    const project = (args.actor as { project?: string } | undefined)?.project;
    if (project !== "crew" && project !== "C:\\work\\crew") return [];
    return tasks.filter((task) => task.projectId === "crew" || task.projectId === project);
  }
  if (command === "decisions_list") return decisions;
  if (command === "docs_list") return docs;
  if (command === "panels_catalog") {
    return [{
      plugin: "my-panels",
      panelId: "board",
      title: "Example board",
      spec: { kind: "bespoke", title: "Example board", html: "<p>Example: board</p>", permissions: ["tasks.read"] },
    }];
  }
  if (command === "plugin:hub|local_hub_read") return stored();
  if (command === "plugin:hub|local_hub_write") {
    const current = stored();
    if (args.expectRev !== current.rev) return null;
    const next = { value: args.value, rev: current.rev + 1 };
    localStorage.setItem(HUB_KEY, JSON.stringify(next));
    queueMicrotask(() => fake.emit("local-hub://changed", { key: args.key, rev: next.rev }));
    return next.rev;
  }
  if (command === "page_frame_put") return "no-frame";
  return null;
});

setHomeOpener((target) => {
  document.body.dataset.opened = JSON.stringify(target);
});

document.getElementById("task-moved")!.addEventListener("click", () => {
  const task = tasks.find((item) => item.id === "write");
  if (task) task.title = "Write the notes now";
  fake.emit("tasks://changed", {});
});

const shell = document.getElementById("shell")!;
const strip = document.createElement("div");
const main = document.createElement("div");
main.id = "root";
main.style.display = "flex";
main.style.minWidth = "0";
main.style.flex = "1";
shell.append(strip, main);

createRoot(strip).render(
  <ProjectStrip
    selection={{ project: "crew", item: "home" }}
    onPickProject={() => undefined}
    onCreateProject={() => undefined}
  />,
);
createRoot(main).render(<HomeView />);
