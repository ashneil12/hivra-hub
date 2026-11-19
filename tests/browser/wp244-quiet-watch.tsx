// Browser proof for WP-244: an automation's "Only run when this changes" field, saved beside it in the app's own store.
import { createRoot } from "react-dom/client";
import { AutomationsView } from "../../src/features/automations/ui/AutomationsView";
import {
  createAutomationTrigger,
  newAutomationDraft,
  type Automation,
} from "../../src/features/automations/model/automations";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const automation: Automation = {
  ...newAutomationDraft("/work/project", "codex", "model"),
  id: "ci-watch",
  name: "Example: CI watch",
  prompt: "Example: tell me when a pull request needs a review.",
  enabled: true,
  workspaceMode: "current",
  reuseSession: false,
  triggers: [createAutomationTrigger("time", "hourly", { id: "time-ci", scheduleKind: "hourly", minute: 5 })],
  cwd: "/work/project",
  nextRunAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

// The local store (local_hub.rs) in memory, with its revision check.
const docs = new Map<string, { value: unknown; rev: number }>();
const saved: unknown[] = [];
(window as unknown as { __wp244: { docs: typeof docs; saved: unknown[] } }).__wp244 = { docs, saved };

installFakeTauri("wp244", (command, args) => {
  if (command === "automations_list") return [automation];
  if (command === "automation_runs_list") return [];
  if (command === "activity_list") return { entries: [], next: null };
  if (command === "automations_upsert") {
    saved.push(args.automation);
    return { ...automation, ...(args.automation as object) };
  }
  if (command === "plugin:hub|local_hub_read") return docs.get(String(args.key)) ?? { value: null, rev: 0 };
  if (command === "plugin:hub|local_hub_write") {
    const key = String(args.key);
    const rev = docs.get(key)?.rev ?? 0;
    if (args.expectRev != null && args.expectRev !== rev) return null;
    docs.set(key, { value: args.value, rev: rev + 1 });
    return rev + 1;
  }
  return null;
});

createRoot(document.getElementById("app")!).render(
  <AutomationsView
    cwd="/work/project"
    recents={[]}
    onClose={() => undefined}
    onLaunch={() => undefined}
    onOpenSession={() => undefined}
  />,
);
