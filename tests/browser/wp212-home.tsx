// WP-212. Example data only. The screen, not the live store.
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/app/shell/Sidebar";
import { UsageFooter } from "../../src/app/shell/UsageFooter";
import type { CatalogPanel } from "../../src/features/panels/model/panelTabs";
import { hideSection, parseArrangement, pinPanel, showSection, unpin, type HomeArrangement } from "../../src/features/home/model/arrangement";
import { moveHomeSection } from "../../src/features/home/model/arrangeHome";
import { HomeScreen, type HomeChief } from "../../src/features/home/ui/HomeScreen";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { setHubSelection, useHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource, HubProject, ProjectItem } from "../../src/features/hub/model/types";
import { ProjectStrip } from "../../src/features/hub/ui/ProjectStrip";
import type { SessionSummary } from "../../src/features/sessions/data/sessionStore";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const KEY = "wp212-home-arrangement";
const params = new URLSearchParams(location.search);
const empty = params.has("empty");
const full = params.has("full");

const EXAMPLE_PROJECTS: HubProject[] = [
  { id: "exo", name: "EXO", shortName: "EXO", iconShape: "rocket", folder: null },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "code", folder: null },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "sparkles", folder: null },
];

const EXAMPLE_ITEMS: ProjectItem[] = [
  { id: "coding-team", kind: "coding-team", title: "Coding team" },
  { id: "leadership-team", kind: "leadership-team", title: "Leadership team" },
];

const EXAMPLE_SESSIONS: SessionSummary[] = [
  {
    id: "ex-notes",
    title: "Example: notes",
    updatedAt: 200,
    createdAt: 100,
    cwd: "/example/hivra",
    harness: "claude",
    model: "opus",
    runtimeMode: "supervised",
  },
];

if (full) {
  installFakeTauri("home-full", () => null);
  const base = hubData();
  const src = Object.create(base) as HubDataSource;
  src.listProjects = () => EXAMPLE_PROJECTS;
  src.listProjectItems = () => EXAMPLE_ITEMS;
  src.listNeeds = () => [];
  src.listSetup = () => [];
  src.listOlder = () => [];
  src.listStuck = () => [];
  src.listMonos = () => [];
  src.connection = () => ({ status: "ready" });
  src.retry = () => undefined;
  setHubDataSource(src);
  setHubSelection({ project: "exo", item: "home" });
}

const catalog: CatalogPanel[] = [{
  plugin: "my-panels",
  panelId: "board",
  title: "Example board",
  spec: { kind: "bespoke", title: "Example board", html: "<p>Example: board</p>", permissions: ["tasks.read"] },
}];

function loadArrangement(): HomeArrangement {
  const raw = localStorage.getItem(KEY);
  if (!raw) return parseArrangement({ order: [], hidden: [], savedAt: 1 });
  try {
    return parseArrangement(JSON.parse(raw) as unknown);
  } catch {
    return parseArrangement({ order: [], hidden: [], savedAt: 1 });
  }
}

function Page() {
  const [arrangement, setArrangement] = useState(loadArrangement);
  const [you, setYou] = useState(empty ? "" : "Example: what's blocking Hivra?");
  const [reply, setReply] = useState(empty ? "" : "Example: Hivra is waiting on the notes.");
  const [options, setOptions] = useState<{ id: string; label: string }[]>(
    empty ? [] : [{ id: "yes", label: "Yes, do that" }, { id: "now", label: "Not now" }],
  );
  function keep(next: HomeArrangement) {
    localStorage.setItem(KEY, JSON.stringify(next));
    setArrangement(next);
  }
  const chief: HomeChief = {
    missing: false,
    name: "Chief of Staff",
    scope: "read all 7 projects",
    you: you || undefined,
    reply: reply || undefined,
    streaming: false,
    options,
    onAdd: () => undefined,
    onOpenChat: () => {
      document.body.dataset.opened = "chief-1";
    },
    onOption: () => undefined,
  };
  return (
    <HomeScreen
      date="Wednesday 11 November"
      chief={chief}
      needs={empty ? [] : [
        {
          key: "n1",
          project: "EXO",
          sentence: "Example: Should we ship the notes?",
          stopped: false,
          blocksShip: true,
          actions: [
            { label: "Yes", onClick: () => undefined },
            { label: "Not yet", onClick: () => undefined },
          ],
          onOpen: () => undefined,
        },
        {
          key: "n2",
          project: "Hivra",
          sentence: "Example: The notes worker stopped.",
          stopped: true,
          actions: [{ label: "Open Ada's chat", onClick: () => undefined }],
          onOpen: () => undefined,
        },
      ]}
      needsTotal={empty ? 0 : 2}
      builders={[]}
      working={empty ? [] : [{
        key: "hivra",
        project: "Hivra",
        text: "Example: 4 workers: chat move fixes, PR watch, commit guard, crew locks",
        since: "since 03:40",
        onOpen: () => undefined,
      }]}
      workingTotal={empty ? 0 : 4}
      done={empty ? [] : [{
        key: "m1",
        project: "EXO",
        text: "Example: Merged the notes",
        time: "09:05",
        onOpen: () => undefined,
      }]}
      onSeeNeeds={() => {
        document.body.dataset.opened = "needs";
      }}
      arrangement={arrangement}
      catalog={catalog}
      known
      failed={false}
      onOpen={() => undefined}
      onMove={(key, dir) => keep(moveHomeSection(arrangement, key, dir))}
      onHide={(key) => keep(hideSection(arrangement, key))}
      onShow={(key) => keep(showSection(arrangement, key))}
      onPin={(plugin, panelId) => keep(pinPanel(arrangement, plugin, panelId))}
      onUnpin={(key) => keep(unpin(arrangement, key))}
      onAsk={(text) => {
        setYou(text);
        setReply("EXO is fine.");
        setOptions([{ id: "ok", label: "Sounds good" }]);
      }}
      renderPanel={() => <p>Example: board</p>}
    />
  );
}

function FullWindow({ children }: { children: ReactNode }) {
  const selection = useHubSelection();
  return (
    <div data-wp212-window className="flex h-full min-h-0 w-full flex-col bg-background-base text-content">
      <div className="flex min-h-0 min-w-0 flex-1">
        <ProjectStrip selection={selection} onPickProject={() => undefined} onCreateProject={() => undefined} />
        <Sidebar
          cwd="/example/hivra"
          open
          sessions={EXAMPLE_SESSIONS}
          busySessionIds={new Set()}
          approvalSessionIds={new Set()}
          status="idle"
          pending={false}
          tab="sessions"
          filesSearchOpen={false}
          projectRailOpen={false}
          compactProjectRail={false}
          onSelectSession={() => undefined}
          onOpenFile={() => undefined}
          onTabChange={() => undefined}
          onFilesSearchOpenChange={() => undefined}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
      <UsageFooter providers={[]} onNewTerminal={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("shell")!).render(full ? <FullWindow><Page /></FullWindow> : <Page />);
