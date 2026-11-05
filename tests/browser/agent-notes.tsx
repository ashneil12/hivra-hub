// Round 20/21 fixture (browser proofs only): an EXO lead's chat with agent-to-agent notes, and a Today-style Stuck row
// whose Open chat opens that Lead's chat (Ash answers the Lead; the Lead relays). Made-up data, labelled "Example:".
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import type { Block } from "../../src/features/sessions/model/session";
import { agentNoteBlock, type AgentNote } from "../../src/features/monos/model/agentNotes";
import { setDelegationActions } from "../../src/features/monos/model/delegationStore";
import type { Delegation } from "../../src/features/monos/model/delegations";
import { stuckOf } from "../../src/features/monos/model/workerStuck";
import { StuckList } from "../../src/features/monos/ui/StuckWorkerCard";
import { addMono, findMono } from "../../src/features/monos/model/mono";
import { saveTranscriptLayout } from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

saveTranscriptLayout("chat");
if (!findMono("vg-game-lead")) addMono({ id: "vg-game-lead", name: "EXO lead", mascot: "invader", color: "hsl(211 92% 62%)", projects: [], sessionId: "lead-chat" });
const now = Date.now();
const lead = { session: "lead-chat", name: "EXO lead" };
const save = { session: "w-save", name: 'Worker "Example: fix the save bug"' };
const hud = { session: "w-hud", name: 'Worker "Example: tidy the HUD"' };
const music = { session: "w-music", name: 'Worker "Example: swap the menu music"' };
const jump = { session: "w-jump", name: 'Worker "Example: fix the jump sound"' };
const n = (over: Partial<AgentNote> & Pick<AgentNote, "kind" | "from" | "to" | "at">): AgentNote => ({ target: "w-save", taskId: "t-save", ...over });

const blocks: Block[] = [
  { id: "u1", role: "user", text: "Example: get the save bug fixed and tidy the HUD before tonight's build." },
  { id: "a1", role: "assistant", text: "Example: on it. I'll hand the save bug to a worker first." },
  agentNoteBlock(n({ kind: "messaged", from: lead, to: save, at: now - 30 * 60_000, line: "Example: fix the save bug" })),
  { id: "a2", role: "assistant", text: "Example: the save fix is with a worker. Next, the HUD and the menu music." },
  agentNoteBlock(n({ kind: "messaged", from: lead, to: hud, at: now - 5 * 60_000, target: "w-hud", taskId: "t-hud" })),
  agentNoteBlock(n({ kind: "messaged", from: lead, to: music, at: now - 5 * 60_000 + 2_000, target: null, taskId: "t-music" })),
  agentNoteBlock(n({ kind: "messaged", from: lead, to: jump, at: now - 5 * 60_000 + 4_000, target: "w-jump", taskId: "t-jump" })),
  // Round 21: a stuck note never folds, even landing among routine ones.
  agentNoteBlock(n({ kind: "stuck", from: save, to: lead, at: now - 4 * 60_000, line: "Example: the test save file is missing" })),
  agentNoteBlock(n({ kind: "reported", from: hud, to: lead, at: now - 4 * 60_000 + 20_000, target: "w-hud", taskId: "t-hud", line: "Example: the HUD is tidied, the score moved top right" })),
  agentNoteBlock(n({ kind: "reported", from: jump, to: lead, at: now - 4 * 60_000 + 40_000, target: "w-jump", taskId: "t-jump", line: "Example: the jump sound plays once now" })),
];

const row: Delegation = {
  id: "t-save", ownerSession: "lead-chat", ownerMono: "vg-game-lead", batchId: "turn-1", parentId: null, rootId: "t-save",
  childSession: "w-save", requestId: "w-save", generation: 1, project: "vg-game", title: "Example: fix the save bug",
  brief: null, goal: null, askIds: [], state: "failed", errorClass: "billing", error: "402", retryable: null, resetsAt: null,
  result: null, pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 30 * 60_000,
  updatedAt: now - 4 * 60_000, settledAt: now - 4 * 60_000, log: [], version: 1, mirroredVersion: 0, mirrorError: null,
} as Delegation;

function Fixture() {
  const view = new URLSearchParams(location.search).get("view") ?? "chat";
  const [shown, setShown] = useState(view);
  const [opened, setOpened] = useState<string[]>([]);
  useEffect(() => {
    setDelegationActions({
      openOwner: (session) => { setOpened((o) => [...o, `owner:${session}`]); setShown("chat"); },
      openChild: (owner, child) => setOpened((o) => [...o, `child:${owner}>${child}`]),
      stopTree: async () => ({ stopped: [], cancelled: [], stopFailed: [] }),
      stopRow: async () => ({ stopped: [], cancelled: [], stopFailed: [] }),
    });
  }, []);
  const stuck = stuckOf(row, now);
  return (
    <div className="flex h-full flex-col text-content" data-opened={opened.join(" ")}>
      {shown === "today" ? (
        <div className="p-6" data-fixture-today>
          <h1 className="mb-4 text-[15px]">Today</h1>
          <StuckList heading="Needs you" stuck={stuck ? [stuck] : []} now={now} variant="row" where={() => "EXO · EXO lead"} />
        </div>
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center border-b border-stroke px-4 text-[13px]" data-fixture-chat="lead-chat">EXO lead</div>
          <div className="min-h-0 flex-1">
            <AgentTranscript blocks={blocks} agentName="EXO lead" agentMascot={{ mascot: "invader", color: "hsl(211 92% 62%)" }} bottomAligned inlineWork />
          </div>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
