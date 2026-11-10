import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../src/app/shell/Sidebar";
import type { SessionSummary } from "../../src/features/sessions/data/sessionStore";
import type { AttentionBlock } from "../../src/features/sessions/model/chatListInbox";
import {
  EMPTY_CHAT_LIST_SESSIONS,
  useChatListAttention,
} from "../../src/features/sessions/model/chatListInboxStore";
import { saveChatListInbox, useChatListInbox } from "../../src/features/settings/model/displayPrefs";
import type { SidebarTabId } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// The real Sidebar, on its Sessions tab, with the chat list's settle, snooze and re-sort setting wired the way App
// wires it: the attention of each chat comes from its blocks through useChatListAttention. The page only supplies the
// chats, the setting's switch (Settings has the real one), and buttons that make a chat need approval or get a message.
const PROJECT = "/work/proj";

installFakeTauri("chat-list", () => null);

const summaries: SessionSummary[] = [
  { id: "alpha", title: "Alpha", updatedAt: 100, createdAt: 100 },
  { id: "beta", title: "Beta", updatedAt: 200, createdAt: 200 },
  { id: "gamma", title: "Gamma", updatedAt: 50, createdAt: 50 },
].map((row) => ({
  ...row,
  cwd: PROJECT,
  harness: "claude" as const,
  model: "opus",
  runtimeMode: "supervised" as const,
}));

type Blocks = Record<string, AttentionBlock[]>;
type Questions = Record<string, { requestId: number; askedAt: number } | undefined>;

// An approval carries the time it was asked, as the app stamps it (apply.ts), so a settled chat comes back only for one
// asked after it was settled.
function approval(id: string, decided?: string): AttentionBlock {
  return { id, role: "approval", text: "", approval: decided ? { decided, at: Date.now() } : { at: Date.now() } };
}

function Fixture() {
  const enabled = useChatListInbox();
  const [tab, setTab] = useState<SidebarTabId>("sessions");
  const [blocks, setBlocks] = useState<Blocks>({});
  // A chat's own open question, as the app keeps it on the session (askedAt is when it was asked).
  const [questions, setQuestions] = useState<Questions>({});
  // Approvals the list is told about from elsewhere (a Lead whose worker asks): ids only, no card in the chat's own
  // blocks and no time. App lists such a Lead in approvalSessionIds and names it in approvalElsewhereSessionIds.
  const [listed, setListed] = useState<ReadonlySet<string>>(new Set());
  const live = useMemo(
    () =>
      summaries.map((row) => ({
        id: row.id,
        busy: true,
        blocks: blocks[row.id] ?? [],
        pendingQuestion: questions[row.id],
      })),
    [blocks, questions],
  );
  // App lists a chat in approvalSessionIds for its own approval or question (sessionNeedsInput) and for a worker's.
  const approvalIds = useMemo(() => {
    const ids = new Set(listed);
    for (const session of live) {
      if (session.pendingQuestion != null || session.blocks.some((block) => block.approval && !block.approval.decided)) {
        ids.add(session.id);
      }
    }
    return ids;
  }, [listed, live]);
  // App passes nothing while the setting is off, so today's list is untouched.
  const attention = useChatListAttention(enabled ? live : EMPTY_CHAT_LIST_SESSIONS);
  const set = (id: string, next: AttentionBlock[]) => setBlocks((current) => ({ ...current, [id]: next }));
  return (
    <div style={{ display: "flex", height: 640 }} className="text-content">
      <Sidebar
        cwd={PROJECT}
        open
        sessions={summaries}
        busySessionIds={new Set()}
        approvalSessionIds={approvalIds}
        approvalElsewhereSessionIds={new Set(listed)}
        chatAttention={attention}
        activeSessionId="none"
        status="idle"
        pending={false}
        tab={tab}
        filesSearchOpen={false}
        projectRailOpen={false}
        compactProjectRail={false}
        onSelectSession={() => {}}
        onOpenFile={() => {}}
        onTabChange={setTab}
        onFilesSearchOpenChange={() => {}}
      />
      <div style={{ minWidth: 0, flex: 1, padding: 12 }} data-fixture-controls>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Settle and snooze"
          onClick={() => saveChatListInbox(!enabled)}
        >
          Settle and snooze
        </button>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
          <button type="button" onClick={() => set("alpha", [approval("p-alpha")])}>
            Needs you
          </button>
          <button type="button" onClick={() => setListed(new Set(["beta"]))}>
            Beta approval listed
          </button>
          <button type="button" onClick={() => setListed(new Set())}>
            Beta listed approval answered
          </button>
          <button
            type="button"
            onClick={() => setQuestions((current) => ({ ...current, beta: { requestId: 1, askedAt: Date.now() } }))}
          >
            Beta asks a question
          </button>
          <button type="button" onClick={() => setQuestions((current) => ({ ...current, beta: undefined }))}>
            Beta question answered
          </button>
          <button
            type="button"
            onClick={() => setQuestions((current) => ({ ...current, alpha: { requestId: 2, askedAt: Date.now() } }))}
          >
            Alpha asks a question
          </button>
          <button type="button" onClick={() => set("alpha", [approval("p-alpha-again")])}>
            Alpha asks again
          </button>
          <button type="button" onClick={() => set("beta", [approval("p-beta")])}>
            Beta asks for approval
          </button>
          <button type="button" onClick={() => set("beta", [approval("p-beta", "allow")])}>
            Beta approval decided
          </button>
          <button
            type="button"
            onClick={() =>
              set("gamma", [{ id: "u-gamma", role: "user", text: "One more thing", sentAt: Date.now() }])
            }
          >
            Gamma gets a message
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
