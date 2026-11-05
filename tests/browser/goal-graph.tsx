// A browser fixture for the goal graph (WP-91). The real orchestrator store runs here, with its Tauri commands faked:
// control_save and control_load keep the run in this page's localStorage, so a reload redraws what was saved. A spec
// commits a run through `window.__goalGraph.commit`, the store's own write path, so every listener (the graph) hears
// it exactly as it would from a live worker.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installFakeTauri } from "./fakeTauri";
import { GoalGraph } from "../../src/features/orchestration/ui/GoalGraph";
import {
  orchestrator,
  type OrchestrationRun,
} from "../../src/features/orchestration/model/orchestration";
import "../../src/styles/index.css";

const LEAD = "goal-lead";
const SAVED = "goal-graph:saved";

installFakeTauri("main", (command, args) => {
  if (command === "control_save") {
    localStorage.setItem(SAVED, String(args.state));
    return null;
  }
  if (command === "control_load") return localStorage.getItem(SAVED);
  return null;
});

// The store's own write path (orchestration.ts `commit`): it updates the snapshot, emits, and saves through control_save.
const store = orchestrator as unknown as { commit(run: OrchestrationRun): Promise<void> };
Object.assign(window, {
  __goalGraph: { commit: (run: OrchestrationRun) => store.commit(run) },
});
void orchestrator.hydrate(LEAD);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GoalGraph leadId={LEAD} />
  </StrictMode>,
);
