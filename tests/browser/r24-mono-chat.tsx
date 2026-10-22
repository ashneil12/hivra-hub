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
import type { Block } from "../../src/features/sessions/model/session";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import { addMono, findMono } from "../../src/features/monos/model/mono";
import "../../src/styles/index.css";

// Round 24 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): a Mono's 1:1 in the real
// SessionPane (transcript, composer, tool card, code block), so its width can be shot at 1512, 1920 and 2560.

// Use the actual composer, review card and transcript. Only native IPC is fake.
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
saveTranscriptAnchor(true);
if (!findMono("projects-manager"))
  addMono({ id: "projects-manager", name: "Projects Manager", mascot: "robot", color: "hsl(211 92% 62%)", projects: [], sessionId: "pm-chat" });
const LONG =
  "Example: here's where the screens work stands. The Sessions card now has a solid edge, the Pac-Man banner is gone from New session, and the 1:1 chat fills the window the same way the rooms do. Only this plain reply text keeps a reading limit of about 75 characters a line, so long answers stay easy to read on a big screen while code blocks, tables and tool cards use the full width.";
const START: Block[] = [
  { id: "u1", role: "user", text: "Example: where are we on the screens work? Show me the width change." },
  { id: "t1", role: "tool", text: "npm test -- surfaceWidth", tool: { kind: "execute", status: "completed" } },
  {
    id: "a1",
    role: "assistant",
    text: `${LONG}\n\nThe change, in short:\n\n- The transcript column has no centred cap any more.\n- The composer fills the width with the room's side padding.\n\n\`\`\`tsx\n// Example: the 1:1 column now matches the room's (GroupChatView: px-6, xl:px-8)\n<div className=\"chat-reading-limit flex min-h-full w-full min-w-0 flex-col justify-end overflow-clip px-2 pb-8 xl:px-4\">\n\`\`\`\n\n| Screen | Before | After |\n| --- | --- | --- |\n| Example: 1:1 transcript | 896px centred | full width |\n| Example: composer | 896px centred | full width |`,
  },
];
saveTranscriptLayout("chat");
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

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const [blocks] = useState<Block[]>(START);
  const busy = false;
  return (
    <>
      <SessionPane
        {...callbacks}
        session={{
          id: "pm-chat",
          title: "Projects Manager",
          cwd: "/repo",
          harness: "claude",
          model: "claude:opus",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks,
          busy,
        }}
        visible
        focused
        composerFocused
        inSplit={false}
        recents={[]}
        transcriptPool={pool}
      />
      <TranscriptPoolOutlet pool={pool} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
