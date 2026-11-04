import "./pm-ui-ideas-setup";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import { TranscriptPool, TranscriptPoolOutlet } from "../../src/features/sessions/ui/TranscriptPool";
import type { Block, Session } from "../../src/features/sessions/model/session";
import { saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import { completionMessage } from "../../src/features/monos/model/monoSessionCompletion";
import { mockHubData } from "../../src/features/hub/model/mockData";
import { setHubDataSource } from "../../src/features/hub/model/hubData";
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

// The chat ideas on the real components, with example data (every made-up line says "Example:"): Ada's
// chat with the EXO coding team's reports in it after Ash was away 4 h (ideas 1, 5) and its composer during a turn (2).
// WP-06 retired the Needs you screen (idea 3). Idea 4 is proved on the real rail (pm-ui-ideas-hub.spec.ts).
installFakeTauri("main", (command) => (command === "session_checkpoint_status" ? { files: [] } : null));
saveTranscriptLayout("chat");
const exo = { ...mockHubData.listProjects()[0], id: "vg-game", name: "EXO", shortName: "EXO" };
setHubDataSource({ ...mockHubData, listProjects: () => [exo] });

const H = 60 * 60 * 1000;
const now = Date.now();
const report = (id: string, at: number, result: string): Block => {
  const message = completionMessage(id, [
    { sessionId: "exo-lead-chat", project: "/code/vg-game", title: "EXO lead", status: "completed", originalPrompt: "Fix the save bug", result, truncated: false },
  ]);
  return { id, role: "user", internal: true, text: message.text, monoSessionCompletion: message.monoSessionCompletion, startedAt: at } as Block;
};
const longReport = [
  "Example: Save bug is fixed and shipped to the preview build.",
  "",
  ...Array.from({ length: 60 }, (_, i) => `- Example: checked save slot ${i + 1}: writes, reloads and survives a crash mid-write.`),
  "",
  "Example: Nothing left open on this one.",
].join("\n");
const blocks: Block[] = [
  { id: "u1", role: "user", text: "Example: Ask EXO to fix the save bug and tell me when it's done.", startedAt: now - 5 * H },
  { id: "a1", role: "assistant", text: "Example: Briefed the EXO coding team. I'll pass on what they report." },
  report("r1", now - 70 * 60_000, "Example: Started on the save bug. The slot index was off by one after a reload."),
  { id: "a2", role: "assistant", text: "Example: EXO has found the cause. Nothing needed from you yet." },
  report("r2", now - 20 * 60_000, longReport),
  { id: "a3", role: "assistant", text: "Example: EXO says the save bug is fixed and on the preview build." },
];

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

const stops: string[] = [];

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Object.assign(window, { proof: { setBusy, stops, sent: [] as [string, string][] } });
  }, []);
  const session: Session = {
    id: "cos-chat", title: "Ada", cwd: "/code", harness: "claude", model: "claude:sonnet", modelSettings: {},
    runtimeMode: "supervised", blocks: busy ? [...blocks, { id: "u2", role: "user", text: "Example: Which build has the fix?", startedAt: Date.now() }, { id: "a4", role: "assistant", text: "" }] : blocks, busy,
  } as Session;
  return (
    <div className="flex h-screen gap-4 p-4 text-content">
      <div data-proof-chat style={{ height: 860 }} className="w-[760px] shrink-0 overflow-hidden rounded-xl ring-1 ring-content/8">
        <SessionPane
          {...callbacks}
          onStop={(id) => void stops.push(`tree:${id}`)}
          onStopTurn={(id) => void stops.push(`turn:${id}`)}
          session={session}
          visible
          focused
          composerFocused={false}
          inSplit={false}
          recents={[]}
          transcriptPool={pool}
        />
        <TranscriptPoolOutlet pool={pool} />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
