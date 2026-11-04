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
import { noteChats, setWaitingChatsHost } from "../../src/features/hub/model/waitingChats";
import { WaitingOnYou } from "../../src/features/hub/ui/WaitingOnYou";
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

// The five ideas on the real components, with example data (every made-up line says "Example:"): Ada's
// chat with the EXO coding team's reports in it after Ash was away 4 h (ideas 1, 5), its composer during a turn (2),
// Needs you with a reason per row and a red-line approval (3). Idea 4 is proved on the real rail (pm-ui-ideas-hub.spec.ts).
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
const sent: [string, string][] = [];
setWaitingChatsHost({ liveQuestion: () => undefined, respond: noop, send: async (id, text) => (sent.push([id, text]), true), open: noop });
const asking = (id: string, title: string, text: string) => ({
  id, cwd: "/code/vg-game", title, harness: "claude" as const,
  blocks: [{ role: "user" as const, text: "go", startedAt: now - 30 * 60_000 }, { role: "assistant" as const, text }],
});
noteChats([
  asking("w1", "Example: Deploy the preview", "Needs Ash (sign in): Example: Log in to Vercel so I can deploy the preview?"),
  asking("w2", "Example: Old menu page", "Needs Ash: Example: Keep the old menu page or archive it?\nMy pick: Archive it, nothing links to it."),
  asking("w3", "Example: Waitlist email", "Needs Ash (red line): Example: Email the 240 people on the waitlist about the delay?\nMy pick: Send it Friday with the new date."),
]);

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Object.assign(window, { proof: { setBusy, stops, sent } });
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
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div data-proof-needs className="rounded-xl p-3 ring-1 ring-content/8">
          <WaitingOnYou projectId={undefined} />
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
