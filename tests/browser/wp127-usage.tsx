// Browser proof for the open chat's context ring and the usage filters (WP-127).
import { useState } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import {
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../../src/features/sessions/ui/TranscriptPool";
import { UsagePage } from "../../src/features/usage/ui/UsagePage";
import type { Block } from "../../src/features/sessions/model/session";
import type { UsageSession } from "../../src/features/usage/model/history";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

// The real pane, composer and transcript. Only native IPC is fake.
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
saveTranscriptLayout("chat");

const now = new Date(2026, 10, 6, 15).getTime();
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

const turnIsLongEnoughToScroll: Block[] = Array.from({ length: 30 }, (_, index) =>
  [
    { id: `user-${index}`, role: "user" as const, text: `Question ${index + 1}` },
    {
      id: `reply-${index}`,
      role: "assistant" as const,
      text: `Answer ${index + 1}. `.repeat(20),
    },
  ],
).flat();

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

function Thread() {
  const [pool] = useState(() => new TranscriptPool());
  return (
    <>
      <SessionPane
        {...callbacks}
        session={{
          id: "wp127-chat",
          title: "Usage visibility",
          cwd: "/repo",
          harness: "claude",
          model: "claude:sonnet",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks: turnIsLongEnoughToScroll,
          context: { used: 275765, window: 1048576 },
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

const sessions: UsageSession[] = [
  {
    id: "s1",
    cwd: "/work/secret-project",
    harness: "claude",
    model: "sonnet-5",
    blocks: [
      {
        id: "b1",
        role: "user",
        startedAt: at(6, 9),
        text: "my bank password is hunter2",
        turnMetrics: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
        turnModel: { harness: "claude", name: "sonnet-5" },
      },
    ],
  },
  {
    id: "s2",
    cwd: "/work/lib",
    harness: "codex",
    model: "gpt-5",
    blocks: [
      {
        id: "b1",
        role: "user",
        startedAt: at(6, 10),
        text: "the reply that must not travel",
        turnMetrics: { inputTokens: 40, outputTokens: 8 },
        turnModel: { harness: "codex", name: "gpt-5" },
      },
    ],
  },
];

createRoot(document.getElementById("thread")!).render(createElement(Thread));

createRoot(document.getElementById("usage")!).render(
  createElement(UsagePage, { sessions, now }),
);
