// Browser proof for the Automations Runs and Map tabs (WP-180a).
import { createRoot } from "react-dom/client";
import { AutomationsView } from "../../src/features/automations/ui/AutomationsView";
import {
  createAutomationTrigger,
  newAutomationDraft,
  type Automation,
} from "../../src/features/automations/model/automations";
import type { ActivityEntry, Who } from "../../src/features/activity/model/activity";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

const appWho: Who = { role: "app" };

function automation(
  partial: Partial<Automation> & Pick<Automation, "id" | "name">,
): Automation {
  return {
    ...newAutomationDraft(partial.cwd ?? "/work/project", "codex", "model"),
    prompt: "PROMPT_SHOULD_NOT_LEAK",
    enabled: partial.enabled ?? true,
    workspaceMode: partial.workspaceMode ?? "current",
    reuseSession: partial.reuseSession ?? false,
    triggers: partial.triggers,
    cwd: partial.cwd ?? "/work/project",
    id: partial.id,
    name: partial.name,
    nextRunAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

const automations: Automation[] = [
  automation({
    id: "morning",
    name: "Morning audit",
    workspaceMode: "worktree",
    reuseSession: true,
    triggers: [
      createAutomationTrigger("time", "weekdays", {
        id: "time-morning",
        time: "09:00",
        scheduleKind: "weekdays",
      }),
      createAutomationTrigger("github", "issue_opened", {
        id: "issue-morning",
        repo: "owner/repo",
      }),
    ],
  }),
  automation({
    id: "inbox",
    name: "Inbox watch",
    cwd: "/work/inbox",
    enabled: false,
    triggers: [
      createAutomationTrigger("github", "issue_opened", {
        id: "issue-inbox",
        repo: "owner/repo",
      }),
    ],
  }),
];

function line(
  partial: Pick<ActivityEntry, "id" | "seq" | "kind" | "summary" | "target" | "link" | "at">,
): ActivityEntry {
  return {
    ...partial,
    actor: appWho,
    initiator: appWho,
    project: "/work/project",
  };
}

const rows: ActivityEntry[] = [
  line({
    id: "started",
    seq: 3,
    kind: "automation.started",
    target: "morning/run-1",
    summary: "Morning audit. Started by the 9:00 schedule.",
    link: "session:chat-1",
    at: 1_700_000_300_000,
  }),
  line({
    id: "finished",
    seq: 2,
    kind: "automation.completed",
    target: "morning/run-1",
    summary: "Morning audit. Finished. Started by the 9:00 schedule.",
    link: "session:chat-1",
    at: 1_700_000_200_000,
  }),
  line({
    id: "failed",
    seq: 1,
    kind: "automation.failed",
    target: "inbox/run-2",
    summary:
      "Inbox watch. Failed: the Claude login has expired. Started by a new issue in owner/repo.",
    link: "",
    at: 1_700_000_100_000,
  }),
];

const tauri = installFakeTauri("automation-runs-map", (command, args) => {
  if (command === "automations_list") return automations;
  if (command === "automation_runs_list") return [];
  if (command === "activity_list") {
    const kind = (args.query as { kind?: unknown } | undefined)?.kind;
    return {
      entries: rows.filter((row) => row.kind === kind),
      next: null,
    };
  }
  return null;
});

(window as unknown as { __wp180aEmit: () => void }).__wp180aEmit = () => {
  rows.push(
    line({
      id: "nightly",
      seq: 4,
      kind: "automation.started",
      target: "nightly/run-9",
      summary: "Nightly. Started by the hourly schedule.",
      link: "session:chat-9",
      at: 1_700_000_400_000,
    }),
  );
  tauri.emit("monocode:activity-changed", null);
};

createRoot(document.getElementById("app")!).render(
  <AutomationsView
    cwd="/work/project"
    recents={[]}
    onClose={() => undefined}
    onLaunch={() => undefined}
    onOpenSession={(id) => {
      document.getElementById("opened")!.textContent = id;
    }}
  />,
);
