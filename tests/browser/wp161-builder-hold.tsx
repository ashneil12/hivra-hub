// WP-161. The real Home with the real worker pool: a launch on a low disk waits, Needs you says so and names the free
// space, and its action opens Settings > Worktrees > Clean up. This page only answers the commands they already call.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { setHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { applyHomeOpen, setHomeOpener, type HomeOpenHands } from "../../src/features/home/model/opener";
import { HomeView } from "../../src/features/home/ui/HomeView";
import { DEFAULT_BUILDER_SCALE } from "../../src/features/monos/model/builderScale";
import {
  enqueueWorker,
  pumpWorkers,
  setBuilderScale,
  workerPoolHost,
  type QueuedWorker,
} from "../../src/features/monos/model/workerPool";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const projects = [{ id: "crew", name: "Crew", shortName: "Crew", iconShape: "folder" as const, folder: "C:\\work\\crew" }];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => projects;
setHubDataSource(src);
setHubSelection({ project: "crew", item: "home" });

let freeDiskGb = 60;
installFakeTauri("home", (command) => {
  if (command === "tasks_list" || command === "decisions_list" || command === "docs_list" || command === "panels_catalog") return [];
  if (command === "plugin:hub|local_hub_read") {
    return {
      value: {
        arrangement: { order: [{ kind: "builtin", id: "needs-you" }, { kind: "builtin", id: "moving-now" }, { kind: "builtin", id: "recent" }], hidden: [], savedAt: 1 },
        recent: [],
        savedAt: 1,
      },
      rev: 1,
    };
  }
  // The machine's reading, the same shape the app's own command returns.
  if (command === "builder_health") return { load1: 0.5, cores: 8, freeMemoryGb: 16, freeDiskGb, readAt: Date.now() };
  return null;
});

const room = () => ({ room: true as const });
const host = workerPoolHost({ openRows: () => [], room });
let launched = 0;

// What delegate_task does: look at the machine, decide, and let the builder wait when it is held.
document.getElementById("launch")!.addEventListener("click", () => {
  void (async () => {
    await host.refreshHealth?.();
    const id = `builder-${++launched}`;
    const job: QueuedWorker = {
      id,
      ownerSession: "lead",
      requestId: id,
      project: "crew",
      projectName: "Crew",
      title: id,
      heavy: false,
      harness: "claude",
      queuedAt: launched,
      input: { brief: id },
    };
    const admission = host.admit(job);
    document.body.dataset.admission = admission.start ? "start" : admission.reason;
    if (!admission.start) enqueueWorker(job);
  })();
});
document.getElementById("pump")!.addEventListener("click", () => {
  void pumpWorkers({
    openRows: () => [],
    room,
    start: async () => undefined,
  }).then((started) => {
    document.body.dataset.started = String(started.length);
  });
});
document.getElementById("disk-24")!.addEventListener("click", () => {
  freeDiskGb = 24;
});
document.getElementById("disk-41")!.addEventListener("click", () => {
  freeDiskGb = 41;
});
document.getElementById("disk-off")!.addEventListener("click", () => {
  setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null });
});

setHomeOpener((target) => {
  document.body.dataset.opened = JSON.stringify(target);
  const hands: HomeOpenHands = {
    closeChrome: () => undefined,
    openInbox: () => undefined,
    openNotes: () => undefined,
    openSession: () => undefined,
    openTeam: () => undefined,
    openSettings: (section, anchor) => {
      document.body.dataset.settings = JSON.stringify({ section, anchor });
    },
    projects: () => projects,
  };
  applyHomeOpen(target, hands);
});

createRoot(document.getElementById("shell")!).render(<HomeView />);
