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
import { hubData, setHubDataSource } from "../../src/features/hub/model/hubData";
import type { HubProject, ProjectItem } from "../../src/features/hub/model/types";
import { HubProjectItems } from "../../src/features/hub/ui/HubProjectItems";
import "../../src/styles/index.css";

// Round 25 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): a Lead's 1:1 in the real
// SessionPane with two worker cards and a long reply, beside the real sidebar project items. `?mono=0` shows the
// sidebar with no 1:1 open (the open team highlighted; Dropwave dropped the Coding team row), the default shows it with the 1:1 open (nothing highlighted there).

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
if (!findMono("hub-lead"))
  addMono({ id: "hub-lead", name: "Example: Hub lead", mascot: "robot", color: "hsl(160 60% 50%)", projects: [], sessionId: "lead-chat" });

const PROJECT: HubProject = { id: "example-hub", name: "Example: MonoCode Hub", shortName: "Hub", iconShape: "code", folder: "/repo/monocode-hub" };
const ITEMS: ProjectItem[] = [
  { id: "coding-team", kind: "coding-team", title: "Coding team" },
  { id: "leadership", kind: "leadership-team", title: "Leadership team" },
];
const src = Object.create(hubData());
src.listProjects = () => [PROJECT];
src.listProjectItems = () => ITEMS;
setHubDataSource(src);
const monoOpen = new URLSearchParams(location.search).get("mono") !== "0";

const LAUNCHES = [
  { sessionId: "w-brief", cwd: "/repo/monocode-hub", title: "Example: read the MonoCode brief and list what it asks for", harness: "claude" as const, model: "claude:opus" },
  { sessionId: "w-colour", cwd: "/repo/monocode-hub", title: "Example: ask the colour question and wait for the answer", harness: "claude" as const, model: "claude:opus" },
];
const views = new Map([
  ["w-brief", { state: "done" as const, title: LAUNCHES[0].title }],
  ["w-colour", { state: "done" as const, title: LAUNCHES[1].title }],
]);
const para = (n: number) =>
  `Example: update ${n}. The worker asked on the first try this time; I asked you, got blue, and passed it back. Waiting for its one-line reply and then I'll report what it said, with nothing else changed in the repo.`;
const START: Block[] = [
  { id: "u0", role: "user", text: "Example: QA test D5, second try. Start exactly one worker with this job and nothing else.", durationMs: 1000 },
  { id: "a0", role: "assistant", text: [1, 2, 3, 4, 5, 6].map(para).join("\n\n") },
  { id: "u1", role: "user", text: "Example: start the two workers for the brief and the colour question.", durationMs: 1000, monoSpawnedSessions: LAUNCHES },
  { id: "a1", role: "assistant", text: "Example: started both workers. I'll tell you when each one reports back." },
  { id: "u2", role: "user", text: "Example: where are they now?", durationMs: 1000 },
  { id: "a2", role: "assistant", text: [7, 8, 9, 10, 11, 12, 13, 14].map(para).join("\n\n") + "\n\nExample: the last line of the last reply ends here, and nothing may cover it." },
];
saveTranscriptLayout("chat");
const noop = () => {};
const callbacks = {
  onFocus: noop, onClose: noop, onCwdChange: noop, onBranchChange: noop, onWorkspaceModeChange: noop, onWorktreeBaseChange: noop,
  onModelChange: noop, onModelSettingsChange: noop, onRuntimeModeChange: noop, onSubmit: noop, onSaveDraft: noop, onRemoveDraft: noop,
  onStop: noop, onCompactContext: () => false, onPlaceSessionInFolder: noop, onDeleteQueuedMessage: noop, onEditQueuedMessage: noop,
  onQueuedMessageEditingChange: noop, onSteerQueuedMessage: noop, onResumeQueue: noop, onUsageLimitResume: noop,
  onUsageLimitResumeAtReset: noop, onUsageLimitDismiss: noop, onApproval: noop, onQuestionReply: noop, onOpenFile: noop,
  onOpenDiff: noop, onOpenPlan: noop, onBuildPlan: noop, onNewTerminal: noop, onOpenMonoSession: noop,
} satisfies Partial<SessionPaneProps>;

function Fixture() {
  const [pool] = useState(() => new TranscriptPool());
  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      <aside data-r25-sidebar style={{ width: 240, flexShrink: 0, paddingTop: 12 }} className="border-r border-content/10">
        <HubProjectItems selection={{ project: PROJECT.id, item: "leadership" }} onPick={noop} monoOpen={monoOpen} />
      </aside>
      <main style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <SessionPane
          {...callbacks}
          session={{
            id: "lead-chat", title: "Example: Hub lead", cwd: "/repo", harness: "claude", model: "claude:opus",
            modelSettings: {}, runtimeMode: "supervised", blocks: START, busy: false,
          }}
          monoLaunchedSessions={views}
          visible
          focused
          composerFocused
          inSplit={false}
          recents={[]}
          transcriptPool={pool}
        />
      </main>
      <TranscriptPoolOutlet pool={pool} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
