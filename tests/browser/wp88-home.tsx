// WP-88. Home's chief chat, over two seeded projects. This page only answers the commands Home already calls.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { openCodingTeam, setHubSelection, useHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { setMonoChatOpener } from "../../src/features/hub/model/hubNav";
import { addStarterMono } from "../../src/features/hub/model/starterMonos";
import { notifyHomeChief, setHomeChiefHost, type HomeChiefSession } from "../../src/features/home/model/homeChief";
import type { ExchangeBlock } from "../../src/features/home/model/exchange";
import { applyHomeOpen, setHomeOpener, type HomeOpenHands } from "../../src/features/home/model/opener";
import { HomeView } from "../../src/features/home/ui/HomeView";
import { ProjectStrip } from "../../src/features/hub/ui/ProjectStrip";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const HUB_KEY = "wp88-home-hub";

type Row = Record<string, unknown>;

const tasks: Row[] = [
  { id: "write", projectId: "crew", title: "Write the notes", status: "In progress", source: "agent", assignee: null, needsYou: false, trashedAt: null, createdAt: 20 },
  { id: "paint", projectId: "site", title: "Paint the door", status: "Blocked", source: "agent", assignee: null, needsYou: false, trashedAt: null, createdAt: 30 },
];

const docs: Row[] = [
  { id: "plan", title: "Crew plan", lastOpenedAt: 40, trashedAt: null },
  { id: "spec", title: "Site spec", lastOpenedAt: 50, trashedAt: null },
];

const projects = [
  { id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder" as const, folder: "C:\\work\\crew" },
  { id: "site", name: "Site", shortName: "Site", iconShape: "folder" as const, folder: "/work/site" },
];

function belongs(project: string | undefined, task: Row): boolean {
  if (project === "crew" || project === "C:\\work\\crew") return task.projectId === "crew";
  if (project === "site" || project === "/work/site") return task.projectId === "site";
  return false;
}

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => projects;
setHubDataSource(src);
setHubSelection({ project: "crew", item: "home" });
addStarterMono("coordinator");
document.body.dataset.tasksCreated = "0";
setMonoChatOpener((id) => {
  document.body.dataset.monoChat = id;
});

const blocks: ExchangeBlock[] = [];
const session: HomeChiefSession = { id: "chief-session", blocks };
setHomeChiefHost({
  ensure: async () => ({ id: "chief-session" }),
  submit: async (_sessionId, text) => {
    blocks.push({ role: "user", text });
    blocks.push({ role: "assistant", text: "EXO is fine." });
    notifyHomeChief();
    return true;
  },
  answer: () => undefined,
  read: () => session,
});

installFakeTauri("home", (command, args) => {
  if (command === "tasks_list") {
    const project = (args.actor as { project?: string } | undefined)?.project;
    return tasks.filter((task) => belongs(project, task));
  }
  if (command === "tasks_create") {
    document.body.dataset.tasksCreated = String(Number(document.body.dataset.tasksCreated ?? "0") + 1);
    const input = args.input as { title?: string; project?: string } | undefined;
    return { id: "filed", title: input?.title ?? "", project: input?.project ?? "" };
  }
  if (command === "decisions_list") return [];
  if (command === "docs_list") return docs;
  if (command === "panels_catalog") return [];
  if (command === "plugin:hub|local_hub_read") {
    const raw = localStorage.getItem(HUB_KEY);
    if (!raw) return { value: { arrangement: { order: [], hidden: [], savedAt: 1 }, recent: [], savedAt: 1 }, rev: 1 };
    return JSON.parse(raw) as unknown;
  }
  if (command === "plugin:hub|local_hub_write") return 1;
  return null;
});

function Shell() {
  const selection = useHubSelection();
  const [, setOpened] = useState(0);
  useEffect(() => setHomeOpener((target) => {
    document.body.dataset.opened = JSON.stringify(target);
    const hands: HomeOpenHands = {
      closeChrome: () => undefined,
      openInbox: () => undefined,
      openNotes: () => undefined,
      openSession: () => undefined,
      openTeam: (projectId) => openCodingTeam(projectId),
      openSettings: () => undefined,
      projects: () => projects,
    };
    applyHomeOpen(target, hands);
    setOpened((n) => n + 1);
  }), []);
  return (
    <>
      <ProjectStrip selection={selection} onPickProject={() => undefined} onCreateProject={() => undefined} />
      <div id="root" style={{ display: "flex", minWidth: 0, flex: "1", flexDirection: "column" }}>
        <HomeView />
      </div>
    </>
  );
}

createRoot(document.getElementById("shell")!).render(<Shell />);
