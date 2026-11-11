// WP-176. The real Home and the real limit line. A priced fixture stands in for the CLI's cost.
// Nothing here calls a billed API. The disk pause stays quiet so the spend limit is what holds the builder.
import { createRoot } from "react-dom/client";
import { setHubDataSource, hubData } from "../../src/features/hub/model/hubData";
import { setHubSelection } from "../../src/features/hub/model/hubNav";
import type { HubDataSource } from "../../src/features/hub/model/types";
import { applyHomeOpen, setHomeOpener, type HomeOpenHands } from "../../src/features/home/model/opener";
import { HomeView } from "../../src/features/home/ui/HomeView";
import {
  enqueueWorker,
  pumpWorkers,
  workerPoolHost,
  type QueuedWorker,
} from "../../src/features/monos/model/workerPool";
import { setSpendClock, setSpendSessions } from "../../src/features/usage/model/spendGate";
import { wireSpendGate } from "../../src/features/usage/model/spendWiring";
import { SpendLimitLine } from "../../src/features/usage/ui/SpendLimitLine";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const now = Date.parse("2026-11-10T15:00:00");
// The hub id (hivra) is not the folder name, so a limit that matches only by folder or only by id fails here.
const projects = [{ id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder" as const, folder: "/work/monocode-hub" }];

const base = hubData();
const src = Object.create(base) as HubDataSource;
src.listProjects = () => projects;
setHubDataSource(src);
setHubSelection({ project: "hivra", item: "home" });

setSpendClock(() => now);
setSpendSessions([
  {
    id: "chat",
    cwd: "/work/monocode-hub",
    harness: "claude",
    model: "opus",
    blocks: [{ id: "t1", role: "user", startedAt: now, turnMetrics: { costUsd: 50, inputTokens: 10 } }],
  },
]);

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
  // Well over the 30 GB floor, so the disk pause does not hide the spend pause.
  if (command === "builder_health") return { load1: 0.5, cores: 8, freeMemoryGb: 16, freeDiskGb: 100, readAt: now };
  return null;
});

// The app wires the spend gate after its native bridge is up. The fixture does the same, so the book is read through the fake.
wireSpendGate();

const room = () => ({ room: true as const });
const host = workerPoolHost({ openRows: () => [], room });
let launched = 0;

document.getElementById("launch")!.addEventListener("click", () => {
  void (async () => {
    await host.refreshHealth?.();
    const id = `builder-${++launched}`;
    const job: QueuedWorker = {
      id,
      ownerSession: "lead",
      requestId: id,
      project: "hivra",
      projectName: "Hivra",
      title: id,
      heavy: false,
      harness: "claude",
      queuedAt: launched,
      input: { brief: id },
    };
    const admission = host.admit(job);
    document.body.dataset.admission = admission.start ? "start" : admission.reason;
    if (!admission.start) await enqueueWorker(job);
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
createRoot(document.getElementById("limit")!).render(<SpendLimitLine project="hivra" indexed />);
