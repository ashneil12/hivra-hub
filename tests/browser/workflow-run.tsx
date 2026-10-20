import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import { TranscriptPool, TranscriptPoolOutlet } from "../../src/features/sessions/ui/TranscriptPool";
import { BeingBuiltView } from "../../src/features/hub/ui/BeingBuiltView";
import { newSession, type Session } from "../../src/features/sessions/model/session";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import {
  configureChildBackend,
  startHarnessBridge,
  type ChildBackend,
} from "../../src/integrations/harness/core/child";
import { sendHarnessTurn } from "../../src/integrations/harness/core/registry";
import { ensureClaudeRegistered } from "../../src/integrations/harness/providers/claude/claudeAdapter";
import { saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import runFixture from "../../src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/workflow-run.ndjson?raw";
import stopFixture from "../../src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/workflow-stopped.ndjson?raw";
import "../../src/styles/index.css";

// The real Claude adapter, registry, transcript and Being built, fed what Claude Code 2.1.302 streamed for a real
// Workflow run against a fake API (the recorded fixtures). Only the child process and native IPC are fake.
const scenario = new URLSearchParams(location.search).get("scenario") === "stop" ? "stop" : "run";
const lines = (scenario === "stop" ? stopFixture : runFixture).split("\n").filter((line) => line.trim());
const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const agentsIn = (rec: Record<string, unknown>) =>
  Array.isArray(rec.workflow_progress)
    ? (rec.workflow_progress as Array<Record<string, unknown>>).filter((entry) => entry.type === "workflow_agent")
    : [];
// Where the replay waits for the test: mid-run (one agent done, one working), or at the first agent frame for Stop.
const holdAt =
  scenario === "stop"
    ? records.findIndex((rec) => agentsIn(rec).length > 0)
    : records.findIndex((rec) => agentsIn(rec).some((agent) => agent.state === "done"));

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "session_checkpoint_status") return { files: [] };
      return null;
    },
  },
});
saveTranscriptLayout("chat");
localStorage.setItem(
  "monocode:mono-roster",
  JSON.stringify([{ id: "vg-game-lead", name: "EXO lead", sessionId: "lead", projects: ["/repo"] }]),
);

const SESSION = "lead";
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const sent: Array<Record<string, unknown>> = [];
let next = 0;
let held = false;

function emit(line: string) {
  handlers.get("harness-stdout")?.({ payload: { sessionId: SESSION, lines: [line] } });
}

async function replay(until: number) {
  held = false;
  while (next < lines.length && next <= until) {
    emit(lines[next]);
    next += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  held = next < lines.length;
}

const backend: ChildBackend = {
  async listen(event, handler) {
    handlers.set(event, handler as (event: { payload: unknown }) => void);
    return () => handlers.delete(event);
  },
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === "harness_resolve_claude") return { path: "/fake/claude" } as T;
    if (command === "harness_spawn") return 4242 as T;
    if (command === "harness_write") {
      const rec = JSON.parse(String(args?.line)) as Record<string, unknown>;
      sent.push(rec);
      const request = rec.request as { subtype?: string } | undefined;
      if (rec.type === "control_request" && request?.subtype === "initialize") {
        setTimeout(() => emit(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: rec.request_id } })), 10);
      } else if (rec.type === "control_request" && request?.subtype === "stop_task") {
        setTimeout(() => void replay(lines.length), 50);
      } else if (rec.type === "user") {
        setTimeout(() => void replay(holdAt), 50);
      }
      return undefined as T;
    }
    return null as T;
  },
};
configureChildBackend(backend);
startHarnessBridge();
ensureClaudeRegistered();

const noop = () => {};
const callbacks = {
  onFocus: noop, onClose: noop, onCwdChange: noop, onBranchChange: noop, onWorkspaceModeChange: noop,
  onWorktreeBaseChange: noop, onModelChange: noop, onModelSettingsChange: noop, onRuntimeModeChange: noop,
  onSubmit: noop, onSaveDraft: noop, onRemoveDraft: noop, onStop: noop, onCompactContext: () => false,
  onPlaceSessionInFolder: noop, onDeleteQueuedMessage: noop, onEditQueuedMessage: noop,
  onQueuedMessageEditingChange: noop, onSteerQueuedMessage: noop, onResumeQueue: noop, onUsageLimitResume: noop,
  onUsageLimitResumeAtReset: noop, onUsageLimitDismiss: noop, onApproval: noop, onQuestionReply: noop,
  onOpenFile: noop, onOpenDiff: noop, onOpenPlan: noop, onBuildPlan: noop, onNewTerminal: noop,
} satisfies Partial<SessionPaneProps>;

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const [session, setSession] = useState<Session>(() => ({
    ...newSession("claude", "/repo"),
    id: SESSION,
    title: "EXO lead",
    model: "claude:claude-sonnet-4-6",
    runtimeMode: "full-access",
    busy: true,
    blocks: [{ id: "prompt", role: "user", text: "Review the parser and the adapter, then verify.", startedAt: Date.now() }],
  }));
  useEffect(() => {
    Object.assign(window, {
      proof: {
        sent,
        held: () => held,
        resume: () => void replay(lines.length),
        title: () => document.title,
      },
    });
    void sendHarnessTurn({
      harness: "claude",
      sessionId: SESSION,
      cwd: "/repo",
      model: "claude:claude-sonnet-4-6",
      modelSettings: {},
      runtimeMode: "full-access",
      text: "RUN-THE-WORKFLOW",
      onEvent: (event) => setSession((current) => applyHarnessEvent(current, event)),
    }).finally(() => setSession((current) => ({ ...current, busy: false })));
  }, []);
  return (
    <>
      <SessionPane
        {...callbacks}
        session={session}
        visible
        focused
        composerFocused={false}
        inSplit={false}
        recents={[]}
        transcriptPool={pool}
      />
      <TranscriptPoolOutlet pool={pool} />
    </>
  );
}

createRoot(document.getElementById("chat")!).render(<Fixture />);
createRoot(document.getElementById("built")!).render(<BeingBuiltView projectId="vg-game" />);
