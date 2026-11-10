import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SessionPane,
  type SessionPaneProps,
} from "../../src/features/sessions/ui/SessionPane";
import {
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../../src/features/sessions/ui/TranscriptPool";
import { setHarnessAvailability } from "../../src/integrations/harness/core/availabilityState";
import { saveChosenClis } from "../../src/features/hub/model/codingTeamHome";
import { HARNESSES, type HarnessId, type Session } from "../../src/features/sessions/model/session";
import { saveTranscriptAnchor, saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

// The real SessionPane, the pane that actually hosts a first-mate chat's lead strip. Only native IPC is fake.
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "control_load") return null;
      if (command === "session_checkpoint_status") return { files: [] };
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});

// Every CLI is installed here. Ash ticked Claude Code, Cursor and Pi at first launch; Codex is installed but was not
// ticked. So the strip may offer Claude Code only, the one ticked CLI that can lead.
const availability = Object.fromEntries(HARNESSES.map((id) => [id, true])) as Record<HarnessId, boolean>;
setHarnessAvailability(availability);
saveChosenClis(["claude", "cursor", "pi"]);
saveTranscriptAnchor(true);
saveTranscriptLayout("chat");

const noop = () => {};
const callbacks = {
  onFocus: noop,
  onClose: noop,
  onCwdChange: noop,
  onBranchChange: noop,
  onWorkspaceModeChange: noop,
  onWorktreeBaseChange: noop,
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

type Switch = { sessionId: string; harness: HarnessId; model: string };

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const [harness, setHarness] = useState<HarnessId>("opencode");
  // The same shapes App.tsx hands its panes: the strip's pick is a model change on this chat's id.
  const [session, setSession] = useState<Session>(() => ({
    id: "lead-chat",
    title: "EXO lead",
    cwd: "/repo/vg-game",
    harness: "opencode",
    model: "opencode:default",
    modelSettings: {},
    runtimeMode: "auto",
    blocks: [],
    firstMate: true,
  }));
  const onModelChange = (sessionId: string, next: HarnessId, model: string) => {
    const switched: Switch = { sessionId, harness: next, model };
    Object.assign(window, { __lastModelChange: switched });
    setHarness(next);
    setSession((current) => ({ ...current, harness: next, model }));
  };
  return (
    <>
      <output data-harness="">{harness}</output>
      <SessionPane
        {...callbacks}
        session={session}
        visible
        focused
        composerFocused
        inSplit={false}
        recents={[]}
        transcriptPool={pool}
        onModelChange={onModelChange}
      />
      <TranscriptPoolOutlet pool={pool} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
