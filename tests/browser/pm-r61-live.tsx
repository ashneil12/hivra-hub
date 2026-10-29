import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ensureBuiltInMonos } from "../../src/features/hub/model/builtInMonos";
import { createChat, requestReply, setGroupChatRunner, startConversation } from "../../src/features/hub/model/hubChats";
import { noteCodingTeamChat } from "../../src/features/hub/model/codingTeam";
import { GroupChatView } from "../../src/features/hub/ui/GroupChatView";
import type { LiveActivity } from "../../src/features/sessions/model/liveActivity";
import { SessionPane, type SessionPaneProps } from "../../src/features/sessions/ui/SessionPane";
import { TranscriptPool, TranscriptPoolOutlet } from "../../src/features/sessions/ui/TranscriptPool";
import type { Block } from "../../src/features/sessions/model/session";
import { saveTranscriptAnchor, saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import { addMono, findMono } from "../../src/features/monos/model/mono";
import "../../src/styles/index.css";

// Round 61 proof fixture (browser preview on the box, not Ash's Mac; made-up data labelled Example:). A simulated stream
// drives the real screens: ?view=room is the leadership room (GroupChatView, a fake runner calling onText/onActivity);
// ?view=mono is a Mono's 1:1 and ?view=team a coding-team chat (the real SessionPane, busy, its blocks fed by the
// driver). window.__r61 is the driver Playwright calls.

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
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

type Driver = {
  step?(activity: LiveActivity): void;
  write?(text: string): void;
  land?(text: string): void;
  blocks?(blocks: Block[], busy?: boolean): void;
};
const driver: Driver = {};
(window as unknown as { __r61: Driver }).__r61 = driver;

const view = new URLSearchParams(location.search).get("view") ?? "room";
localStorage.clear();
saveTranscriptAnchor(true);
saveTranscriptLayout("chat");

function Room() {
  const [ids] = useState(() => {
    ensureBuiltInMonos();
    const room = createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager", "alfred"]);
    const conv = startConversation(room.id, "Example: where are we on the Tally release? Check the app builds.");
    setGroupChatRunner({
      run: (request) => {
        if (request.monoId !== "chief-of-staff") return Promise.resolve({ kind: "reply", text: "NO_REPLY" });
        driver.step = (a) => request.onActivity?.(a);
        driver.write = (t) => request.onText?.(t);
        return new Promise((resolve) => (driver.land = (text) => resolve({ kind: "reply", text })));
      },
    });
    void requestReply(room.id, conv);
    return { room: room.id };
  });
  return (
    <div className="flex h-full" data-proof-room>
      <aside className="h-full w-[220px] border-r border-content/10 bg-background-sidebar" />
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <GroupChatView chatId={ids.room} projectId="hub" />
      </main>
    </div>
  );
}

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

function Chat({ team }: { team: boolean }) {
  const id = team ? "team-chat" : "pm-chat";
  const [pool] = useState(() => new TranscriptPool());
  const [state, setState] = useState<{ blocks: Block[]; busy: boolean }>({
    blocks: [{ id: "u1", role: "user", text: "Example: fix the date picker on the Tally screen and run the checks.", startedAt: Date.now() }],
    busy: true,
  });
  useEffect(() => {
    driver.blocks = (blocks, busy = true) => setState({ blocks, busy });
  }, []);
  return (
    <>
      <SessionPane
        {...callbacks}
        session={{
          id,
          title: team ? "Example: Tally date picker" : "Projects Manager",
          cwd: "/repo",
          harness: "claude",
          model: "claude:opus",
          modelSettings: {},
          runtimeMode: "supervised",
          blocks: state.blocks,
          busy: state.busy,
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

if (view === "mono" && !findMono("projects-manager"))
  addMono({ id: "projects-manager", name: "Projects Manager", mascot: "robot", color: "hsl(211 92% 62%)", projects: [], sessionId: "pm-chat" });
if (view === "team") {
  noteCodingTeamChat("team-chat", "example-tally");
}
createRoot(document.getElementById("root")!).render(view === "room" ? <Room /> : <Chat team={view === "team"} />);
