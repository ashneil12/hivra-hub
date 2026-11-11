// Browser proof for a busy chat whose agent cannot redirect (WP-115).
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { IDLE_COMPACT_NOTICE } from "../../src/features/sessions/model/contextCeiling";
import type { Block, HarnessId } from "../../src/features/sessions/model/session";
import {
  SessionPane,
  type SessionPaneProps,
} from "../../src/features/sessions/ui/SessionPane";
import {
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../../src/features/sessions/ui/TranscriptPool";
import {
  registerHarness,
  type HarnessAdapter,
} from "../../src/integrations/harness/core/registry";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// Native IPC is faked; any command this page does not expect fails loudly.
installFakeTauri("main", (command) => {
  if (command === "control_load") return null;
  if (command === "session_checkpoint_status") return { files: [] };
  throw new Error(`Unexpected fixture command: ${command}`);
});

function stub(id: HarnessId, canSteer?: boolean): HarnessAdapter {
  return {
    id,
    live: true,
    ...(canSteer === undefined ? {} : { canSteer }),
    async sendTurn() {},
    async steerTurn() {},
    async cancelTurn() {},
    respondApproval() {},
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
  };
}

// After imports, before render. A missing adapter must not look unable to steer.
registerHarness(stub("grok", false));
registerHarness(stub("claude"));

const noop = () => {};
const callbacks = {
  onFocus: noop,
  onClose: noop,
  onCwdChange: noop,
  onBranchChange: noop,
  onWorkspaceModeChange: noop,
  onWorktreeBaseChange: noop,
  onModelChange: noop,
  onModelSettingsChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
  onSaveDraft: noop,
  onRemoveDraft: noop,
  onStop: noop,
  onCompactContext: () => false,
  onPlaceSessionInFolder: noop,
  onDeleteQueuedMessage: noop,
  onEditQueuedMessage: noop,
  onQueuedMessageEditingChange: noop,
  onSteerQueuedMessage: noop,
  onResumeQueue: noop,
  onUsageLimitResume: noop,
  onUsageLimitResumeAtReset: noop,
  onUsageLimitDismiss: noop,
  onApproval: noop,
  onQuestionReply: noop,
  onOpenFile: noop,
  onOpenDiff: noop,
  onOpenPlan: noop,
  onBuildPlan: noop,
  onNewTerminal: noop,
} satisfies Partial<SessionPaneProps>;

const queued = [{ id: "q1", text: "hold this", attachments: [] }];

function Pane({
  paneId,
  harness,
  blocks,
  draft = "next",
  queuedMessages = queued,
  idleCompacting = false,
}: {
  paneId: string;
  harness: HarnessId;
  blocks: Block[];
  draft?: string;
  queuedMessages?: { id: string; text: string; attachments: [] }[];
  idleCompacting?: boolean;
}) {
  const [pool] = useState(() => new TranscriptPool());
  return (
    <div id={paneId} style={{ height: 360, width: 850 }}>
      <SessionPane
        {...callbacks}
        session={{
          id: paneId,
          title: paneId,
          cwd: "/repo",
          harness,
          model: harness === "grok" ? "grok:build" : "claude:opus",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks,
          busy: true,
          ...(idleCompacting ? { idleCompacting: true } : {}),
          composerSeed: draft,
          queuedMessages,
        }}
        visible
        focused
        composerFocused
        inSplit={false}
        recents={[]}
        transcriptPool={pool}
      />
      <TranscriptPoolOutlet pool={pool} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <Pane paneId="grok" harness="grok" blocks={[]} />
    <Pane paneId="grok-empty" harness="grok" blocks={[]} draft="" queuedMessages={[]} />
    <Pane
      paneId="claude"
      harness="claude"
      blocks={[{ id: "notice", role: "system", text: IDLE_COMPACT_NOTICE }]}
    />
    <Pane paneId="compacting" harness="claude" blocks={[]} idleCompacting />
    <Pane
      paneId="compacting-empty"
      harness="claude"
      blocks={[]}
      draft=""
      queuedMessages={[]}
      idleCompacting
    />
  </>,
);
