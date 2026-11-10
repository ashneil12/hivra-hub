import { useEffect, useRef, useState } from "react";
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
import "../../src/styles/index.css";

// Use the real session pane. Only native IPC is fake.
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

const blocks: Block[] = [
  {
    id: "u1",
    role: "user",
    text: "Explain the parser",
    durationMs: 1000,
    btwThreads: [
      {
        id: "side-1",
        sourceEndBlockId: "u1",
        createdAt: 1,
        updatedAt: 2,
        status: "ready",
        harness: "claude",
        messages: [
          { id: "q", role: "user", text: "Why the parser?", createdAt: 1 },
          {
            id: "a",
            role: "assistant",
            text: "It splits tokens.",
            createdAt: 2,
          },
        ],
      },
    ],
  },
  { id: "a1", role: "assistant", text: "It changes the parser." },
  {
    id: "t1",
    role: "tool",
    text: "Read",
    tool: {
      title: "Read",
      preview: {
        kind: "read",
        path: "/repo/src/parser.ts",
        additions: 2,
        deletions: 0,
      },
    },
  },
];

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const submits = useRef(0);
  useEffect(() => {
    Object.assign(window, {
      __wp112: {
        blocks,
        get submits() {
          return submits.current;
        },
      },
    });
  }, []);
  return (
    <>
      <SessionPane
        {...callbacks}
        onSubmit={() => {
          submits.current += 1;
        }}
        onBtwSubmit={() => true}
        onBtwRetry={noop}
        session={{
          id: "parent-chat",
          title: "Parser",
          cwd: "/repo",
          harness: "claude",
          model: "claude:sonnet-4.6",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks,
          busy: false,
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
