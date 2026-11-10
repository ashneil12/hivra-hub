// WP-73. The real strip and the real Home. This page only answers the commands they already call.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { openCodingTeam, setHubSelection, useHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { applyHomeOpen, setHomeOpener, type HomeOpenHands } from "../../src/features/home/model/opener";
import { takeHomeDecision } from "../../src/features/home/model/pending";
import { HomeView } from "../../src/features/home/ui/HomeView";
import { ProjectStrip } from "../../src/features/hub/ui/ProjectStrip";
import { FirstMateInbox } from "../../src/features/crew/ui/FirstMateInbox";
import type { FirstMateItem } from "../../src/features/crew/model/inbox";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";
import { importFromAshOsAgain } from "../../src/features/hub/model/localHub/ashOsImport";
import { appHubTransport } from "../../src/features/hub/model/localHub/localTransport";

const empty = new URLSearchParams(location.search).has("empty");
// No project at all, as on a Mac whose projects are still in Ash OS: Home says why and offers the way back.
const noProjects = new URLSearchParams(location.search).has("noprojects");
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

const inboxItems: FirstMateItem[] = [
  { id: "ship", kind: "decision", title: "Should we ship?", body: "", statusWord: null, chatId: null, workerIds: [], options: [], recommended: null, project: "C:\\work\\crew", key: "ship", since: 1, updatedAt: 1 },
  { id: "font", kind: "decision", title: "Which font?", body: "", statusWord: null, chatId: null, workerIds: [], options: [], recommended: null, project: "C:\\work\\crew", key: "font", since: 2, updatedAt: 2 },
];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => (noProjects ? [] : projects);
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

document.getElementById("task-moved")!.addEventListener("click", () => {
  const task = tasks.find((item) => item.id === "write");
  if (task) task.title = "Write the notes now";
  fake.emit("tasks://changed", {});
});

/** The inbox Home asked for. The list's project is the folder, the same path the opener queues. */
function OpenedInbox({ tick }: { tick: number }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    const key = takeHomeDecision(inboxItems.map((item) => ({ key: item.key, project: item.project })));
    if (key) setSelectedKey(key);
  }, [tick]);
  return <FirstMateInbox items={inboxItems} selectedKey={selectedKey} />;
}

function Shell() {
  const selection = useHubSelection();
  const [chatId, setChatId] = useState<string | null>(null);
  const [inboxTick, setInboxTick] = useState(0);
  useEffect(() => setHomeOpener((target) => {
    document.body.dataset.opened = JSON.stringify(target);
    const hands: HomeOpenHands = {
      closeChrome: () => undefined,
      openInbox: () => setInboxTick((n) => n + 1),
      openNotes: () => undefined,
      // The session open does not move the hub. applyHomeOpen does, when the project has a folder.
      openSession: (id) => setChatId(id),
      openTeam: (projectId) => openCodingTeam(projectId),
      projects: () => projects,
    };
    applyHomeOpen(target, hands);
  }), []);
  return (
    <>
      <ProjectStrip
        selection={selection}
        onPickProject={() => undefined}
        onCreateProject={() => undefined}
      />
      <div id="root" style={{ display: "flex", minWidth: 0, flex: "1", flexDirection: "column" }}>
        <HomeView />
        {chatId ? <section aria-label="Opened chat" data-open-id={chatId}>Opened chat</section> : null}
        <OpenedInbox tick={inboxTick} />
      </div>
    </>
  );
}

// What the start-up import leaves when Ash OS doesn't answer: nothing decided, so Home offers to try again.
if (noProjects) {
  void importFromAshOsAgain(appHubTransport().hub, {
    fetch: async () => ({ state: "unreachable", message: "no answer", projects: [], memberships: [], pages: [] }),
    ask: async () => "later",
  });
}

createRoot(document.getElementById("shell")!).render(<Shell />);
