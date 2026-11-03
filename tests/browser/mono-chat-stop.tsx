import "./macPlatform";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import { TranscriptPool, TranscriptPoolOutlet } from "../../src/features/sessions/ui/TranscriptPool";
import { newSession, type Session } from "../../src/features/sessions/model/session";
import { applyHarnessEvent } from "../../src/integrations/harness/core/apply";
import { configureChildBackend, startHarnessBridge, type ChildBackend } from "../../src/integrations/harness/core/child";
import { sendHarnessTurn } from "../../src/integrations/harness/core/registry";
import { ensureClaudeRegistered } from "../../src/integrations/harness/providers/claude/claudeAdapter";
import { saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import { useFloatingMono } from "../../src/app/hooks/useFloatingMono";
import {
  delegationRows,
  setDelegationActions,
  setDelegationRows,
  subscribeDelegations,
} from "../../src/features/monos/model/delegationStore";
import { isOpenDelegation, type Delegation } from "../../src/features/monos/model/delegations";
import { DELEGATIONS_CHANGED } from "../../src/features/monos/model/delegations";
import { FLOATING_MONO_CHANGED, FLOATING_MONO_REQUEST } from "../../src/features/monos/model/floatingMono";
import stopFixture from "../../src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/workflow-stopped.ndjson?raw";
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

// A Lead's chat in the main window and the same Mono's pop-out chat beside it, each in its own frame (two webviews).
// The main window is the real chat on the real Claude adapter, replaying what Claude Code 2.1.302 streamed for a
// workflow run that was stopped, with one brief out to a worker. It runs the real useFloatingMono hook; the native
// relay between the windows (mono_chat.rs: requests queued for the owner, its replies, its published session) is the
// part faked here, with the same commands and events.
const MONO = "vg-game-lead";
const SESSION = "lead";
const lines = stopFixture.split("\n").filter((line) => line.trim());
const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const holdAt = records.findIndex(
  (rec) =>
    Array.isArray(rec.workflow_progress) &&
    (rec.workflow_progress as Array<{ type?: string }>).some((entry) => entry.type === "workflow_agent"),
);

saveTranscriptLayout("chat");
localStorage.setItem(
  "monocode:mono-roster",
  JSON.stringify([{ id: MONO, name: "EXO lead", sessionId: SESSION, projects: ["/repo"] }]),
);

type Stop = { kind: string; [key: string]: unknown };
const stops: Stop[] = [];
const sent: Array<Record<string, unknown>> = [];

// --- The native relay (mono_chat.rs), between this window (the owner) and the pop-out.
type Pending = { id: number; action: unknown; accepted: boolean; done?: (error: string | null) => void };
const relay = { monos: [] as unknown[], session: null as unknown, pending: [] as Pending[], counter: 0 };
let floatingEmit: ((event: string, payload: unknown) => void) | null = null;
const view = () => ({ monos: relay.monos, monoId: MONO, session: relay.session, error: null });
const pushView = () => floatingEmit?.(FLOATING_MONO_CHANGED, view());
const owner = installFakeTauri("main", (command, args) => {
  switch (command) {
    case "mono_chat_sync":
      relay.monos = args.monos as unknown[];
      pushView();
      return null;
    case "mono_chat_take":
      return relay.pending.filter((p) => !p.accepted).map((p) => ({ id: p.id, monoId: MONO, action: p.action }));
    case "mono_chat_accept": {
      const pending = relay.pending.find((p) => p.id === args.id);
      if (!pending) return false;
      pending.accepted = true;
      return true;
    }
    case "mono_chat_reply": {
      const pending = relay.pending.find((p) => p.id === args.id);
      relay.pending = relay.pending.filter((p) => p.id !== args.id);
      pending?.done?.((args.error as string | null) ?? null);
      return null;
    }
    case "mono_chat_publish":
      relay.session = args.session;
      pushView();
      return null;
    case "session_checkpoint_status":
      return { files: [] };
    default:
      return null;
  }
});
function enqueue(action: unknown, done?: Pending["done"]) {
  relay.pending.push({ id: ++relay.counter, action, accepted: false, done });
  owner.emit(FLOATING_MONO_REQUEST, null);
}
Object.assign(window, {
  monoChatNative: {
    attach(emit: (event: string, payload: unknown) => void) {
      floatingEmit = emit;
      enqueue({ kind: "open" });
    },
    invoke(command: string, args: Record<string, unknown>) {
      if (command === "mono_chat_state") return view();
      if (command === "mono_chat_action")
        return new Promise((resolve, reject) =>
          enqueue(args.action, (error) => (error ? reject(error) : resolve(null))),
        );
      if (command === "delegations_recent") return delegationRows();
      return null;
    },
  },
});
subscribeDelegations(() => floatingEmit?.(DELEGATIONS_CHANGED, null));

// --- The delegation tree as App.tsx lends it (useDelegationTree): one brief out to a worker.
const row = (child: string, title: string): Delegation => ({
  id: `d-${child}`,
  ownerSession: SESSION,
  ownerMono: MONO,
  batchId: null,
  parentId: null,
  rootId: `d-${child}`,
  childSession: child,
  requestId: `r-${child}`,
  generation: 1,
  project: "/repo",
  title,
  brief: title,
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
  createdAt: Date.now(),
  updatedAt: Date.now(),
  settledAt: null,
  log: [],
  version: 1,
  mirroredVersion: 1,
  mirrorError: null,
});
setDelegationRows([row("worker-save", "Fix the save bug")]);
const cancel = (open: (r: Delegation) => boolean) => {
  const hit = delegationRows().filter((r) => open(r) && isOpenDelegation(r));
  setDelegationRows(delegationRows().map((r) => (hit.includes(r) ? { ...r, state: "cancelled" } : r)));
  return { stopped: hit.map((r) => r.childSession), cancelled: hit.map((r) => r.id), stopFailed: [] };
};
setDelegationActions({
  openOwner: () => {},
  openChild: () => {},
  stopTree: async (chat) => {
    stops.push({ kind: "stopTree", chat });
    return cancel((r) => r.ownerSession === chat);
  },
  stopRow: async (target) => {
    stops.push({ kind: "stopRow", child: target.childSession });
    return cancel((r) => r.id === target.id);
  },
});

// --- Claude Code itself: the recorded stream, held at the run's first agent until a Stop arrives.
const handlers = new Map<string, (event: { payload: unknown }) => void>();
let next = 0;
let held = false;
const emit = (line: string) => handlers.get("harness-stdout")?.({ payload: { sessionId: SESSION, lines: [line] } });
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
        setTimeout(
          () => emit(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: rec.request_id } })),
          10,
        );
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

function MainWindow() {
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
  const latest = useRef(session);
  latest.current = session;
  // The app's own floating-chat host (App.tsx); the Stops it adds are the hook's.
  useFloatingMono([session], "roster", true, {
    open: async () => latest.current,
    submit: () => true,
    stop: (id) => void stops.push({ kind: "stop", id }),
    approval: noop,
    question: noop,
    questionInteraction: noop,
    reveal: async () => {},
    openFile: noop,
    resume: noop,
    create: () => MONO,
  });
  useEffect(() => {
    Object.assign(window, { proof: { sent, stops, held: () => held } });
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

createRoot(document.getElementById("chat")!).render(<MainWindow />);
// The pop-out opens once the relay above exists, as the native window opens after the app.
(document.getElementById("floating") as HTMLIFrameElement).src = "./mono-chat-stop-floating.html";
