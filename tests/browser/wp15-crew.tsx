import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { Decision } from "../../src/features/firstmate/model/steering";
import type { Delegation } from "../../src/features/monos/model/delegations";
import type { SessionSummary } from "../../src/features/sessions/data/sessionStore";
import { Sidebar } from "../../src/app/shell/Sidebar";
import { FirstMateInboxPanel } from "../../src/features/crew/ui/FirstMateInboxPanel";
import type { SidebarTabId } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// The real Crew tab and Inbox. This page only names the Classic tabs and
// answers the commands those two panels already call. It does not build rows.
const PROJECT = "/work/proj";
const START = 1_700_000_000_000;

const commands: string[] = [];
let quiet = false;
let answered = false;

function worker(
  row: Pick<Delegation, "id" | "title" | "status" | "childSession" | "createdAt"> &
    Partial<Delegation>,
): Delegation {
  return {
    ownerSession: "lead",
    ownerMono: null,
    batchId: null,
    parentId: null,
    rootId: row.id,
    requestId: row.id,
    generation: 1,
    project: PROJECT,
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    updatedAt: START,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    statusNotice: null,
    questionOwner: null,
    ...row,
  };
}

function workers(): Delegation[] {
  const rows = [
    worker({
      id: "working",
      title: "Fix the save bug",
      status: "working",
      createdAt: START - 12 * 60_000,
      childSession: "chat-working",
      // WP-141: why the crew picked this worker's CLI, kept on its recorded line.
      log: [{ at: START - 12 * 60_000, by: "owner:lead", event: "recorded", why: "Builder role prefers Codex." }],
    }),
    worker({
      id: "needs",
      title: "Which name to ship",
      status: answered ? "working" : "needs-you",
      createdAt: START - 8 * 60_000,
      childSession: "chat-needs",
      questionOwner: answered ? null : "person",
    }),
    worker({
      id: "done",
      title: "Ready to land",
      status: "done",
      state: "completed",
      createdAt: START - 60 * 60_000,
      settledAt: START,
      childSession: "chat-done",
    }),
    worker({
      id: "failed",
      title: "Save bug",
      status: "failed",
      state: "failed",
      createdAt: START - 20 * 60_000,
      childSession: "chat-failed",
      statusNotice: "The save did not finish.",
      error: "at save (/tmp/a.ts:1)\nsk-live-secret",
    }),
    worker({
      id: "paused",
      title: "Waiting on the limit",
      status: "paused",
      errorClass: "usage_limit",
      statusNotice: "Waiting for a usage limit",
      createdAt: START - 30 * 60_000,
      childSession: "chat-paused",
    }),
  ];
  return quiet ? [] : rows;
}

function decision(): Decision {
  return {
    project: PROJECT,
    decisionKey: "ship",
    question: "Ship it now?",
    options: ["Ship it", "Wait"],
    recommended: "Ship it",
    askedBy: "lead-chat",
    askedByMono: null,
    waiting: ["needs"],
    state: answered ? "answered" : "open",
    answer: answered ? "Ship it" : null,
    answeredBy: answered ? "person" : null,
    answeredAt: answered ? START : null,
    createdAt: START,
    updatedAt: START,
    version: answered ? 2 : 1,
  };
}

const DELIVERIES = [
  {
    delegationId: "done",
    mode: "pr",
    state: "ready",
    url: "https://github.com/acme/app/pull/12",
    number: 12,
    branch: "fix-save",
    updatedAt: 1,
  },
];

const WATCHES = [
  {
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    repo: "acme/app",
    status: { pending: 1, failed: [], passed: false, checks: 1 },
  },
];

const sessions: SessionSummary[] = [
  {
    id: "chat-working",
    cwd: PROJECT,
    harness: "claude",
    model: "opus",
    runtimeMode: "supervised",
    title: "Fix the save bug",
    branch: "fix-save",
    additions: 12,
    deletions: 3,
    createdAt: START,
    updatedAt: START,
  },
];

const bridge = installFakeTauri("crew", (command, args) => {
  commands.push(command);
  if (command === "delegations_list_open") return workers().filter((row) => row.status !== "done");
  if (command === "delegations_recent") return workers();
  if (command === "decisions_list") return quiet ? [] : [decision()];
  if (command === "delivery_list") return quiet ? [] : DELIVERIES;
  if (command === "pr_watch_list") return quiet ? [] : WATCHES;
  if (command === "decisions_answer") {
    answered = true;
    const outcome = {
      applied: true,
      decision: decision(),
      released: [],
      releasedTasks: ["needs"],
    };
    queueMicrotask(() => {
      bridge.emit("monocode:delegations-changed", {});
      bridge.emit("hivra:decisions-changed", {});
    });
    return outcome;
  }
  // An unknown command is not a renderable value. Returning the args object
  // crashes a child that paints the result.
  return null;
});

Object.assign(window, { __crewCommands: commands });

function Fixture() {
  const [, redraw] = useState(0);
  const [tab, setTab] = useState<SidebarTabId>("crew");
  return (
    <div style={{ display: "flex", height: 640 }}>
      <Sidebar
        cwd={PROJECT}
        open
        sessions={sessions}
        busySessionIds={new Set()}
        approvalSessionIds={new Set()}
        activeSessionId="chat-working"
        status="idle"
        pending={false}
        tab={tab}
        filesSearchOpen={false}
        projectRailOpen={false}
        compactProjectRail={false}
        onSelectSession={() => {}}
        onOpenFile={() => {}}
        onTabChange={setTab}
        onFilesSearchOpenChange={() => {}}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
      <FirstMateInboxPanel cwd={PROJECT} />
      <button
        type="button"
        onClick={() => {
          quiet = true;
          bridge.emit("monocode:delegations-changed", {});
          bridge.emit("hivra:decisions-changed", {});
          redraw((n) => n + 1);
        }}
      >
        A quiet hour
      </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
