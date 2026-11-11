import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "../../src/features/sessions/model/session";
import { TeleportMovePanel } from "../../src/features/connections/ui/TeleportMovePanel";
import { TeleportHeaderBand } from "../../src/features/connections/ui/TeleportNotice";
import { localMoveEndpoint, type LocalChatPort } from "../../src/features/connections/model/teleportLocal";
import { sha256Hex, type ChatSnapshot, type Holds, type MoveEndpoint, type MovePayload } from "../../src/features/connections/model/teleport";
import { movedBlocks, teleportStateOf } from "../../src/features/connections/model/teleportState";
import "../../src/styles/index.css";

// WP-177: the start-and-approve panel in a browser, with the local chat store and an in-memory host. The page reads
// flags: ?busy=1 makes the chat running, ?cannotResume=1 makes the host refuse to resume it, ?back=1 starts from a chat
// that moved to the host (the host holds its live copy, so the panel moves it back), and ?lostReply=1 loses the host's
// reply to activation and to the check that follows, so the result is unknown and the chat stays locked until Retry.
const params = new URLSearchParams(location.search);
const busy = params.get("busy") === "1";
const cannotResume = params.get("cannotResume") === "1";
const back = params.get("back") === "1";
const lostReply = params.get("lostReply") === "1";

const copyBlocks = [
  { id: "u1", role: "user", text: "ship it" },
  { id: "a1", role: "assistant", text: "shipped" },
];
const session = {
  id: "fixture-chat",
  harness: "claude",
  model: "test-model-1",
  modelSettings: { effort: "high" },
  runtimeMode: "default",
  title: "Deploy with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX",
  cwd: "/projects/fixture",
  busy,
  // A chat that moved to the host is shown from its marker here. The row also keeps the person's own messages.
  blocks: back ? movedBlocks("Studio box", "2026-11-11T09:00:00.000Z", "host-a") : copyBlocks,
  providerSessionId: back ? undefined : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  queuedMessages: back ? [] : [{ id: "q1", text: "then tell the team", attachments: [] }],
} as unknown as Session;

function memoryPort(initial: Session): LocalChatPort & { current(): Session } {
  let row = initial;
  return {
    async get() {
      return row;
    },
    async put(next) {
      row = next;
    },
    current: () => row,
  };
}

function memoryRemote(id: string): MoveEndpoint {
  const live = new Map<string, ChatSnapshot>();
  const incoming = new Map<string, { moveId: string; payload: MovePayload }>();
  const activated = new Map<string, string>();
  // The host's live copy of a chat that moved to it (the move back starts from this).
  if (back) {
    live.set("fixture-chat", {
      chatId: "fixture-chat",
      provider: "claude",
      providerSessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      model: "test-model-1",
      effort: "high",
      title: session.title,
      transcript: JSON.stringify(copyBlocks),
      queued: [],
      turnRunning: false,
      approvalPending: false,
    });
  }
  // The reply to the host's activation, and the first check after it, are lost (the host did both steps).
  let lostActivateReply = lostReply;
  let lostCheck = lostReply;
  return {
    id,
    async read(chatId) {
      const l = live.get(chatId);
      return l ? { owner: id, live: { ...l } } : null;
    },
    async freeze() {
      return true;
    },
    async thaw() {},
    async canResume() {
      return cannotResume ? { ok: false, reason: "this host does not run claude" } : { ok: true };
    },
    async receive(chatId, moveId, payload: MovePayload) {
      incoming.set(chatId, { moveId, payload });
      return { ok: true, transcriptSha256: await sha256Hex(payload.chat.transcript) };
    },
    async discard(chatId, moveId) {
      if (incoming.get(chatId)?.moveId === moveId) incoming.delete(chatId);
    },
    async activate(chatId, moveId) {
      const copy = incoming.get(chatId);
      if (!copy || copy.moveId !== moveId) throw new Error("No copy of this chat is stored here to open");
      live.set(chatId, { ...copy.payload.chat, turnRunning: false, approvalPending: false });
      activated.set(chatId, moveId);
      incoming.delete(chatId);
      if (lostActivateReply) {
        lostActivateReply = false;
        throw new Error("The host reply to activation was lost");
      }
    },
    async release(chatId) {
      // The host's copy leaves once the other side holds the chat (a move back).
      live.delete(chatId);
    },
    async holds(chatId, moveId): Promise<Holds> {
      if (lostCheck) {
        lostCheck = false;
        throw new Error("The host could not be asked whether it holds the chat");
      }
      if (activated.get(chatId) === moveId) return "live";
      return incoming.get(chatId)?.moveId === moveId ? "incoming" : "none";
    },
    // The host's atomic answer for a move that will not complete (as host/teleport/store.ts abort): a copy it opened is live.
    async abort(chatId, moveId): Promise<"aborted" | "live"> {
      if (activated.get(chatId) === moveId) return "live";
      if (incoming.get(chatId)?.moveId === moveId) incoming.delete(chatId);
      return "aborted";
    },
  };
}

function Fixture() {
  const port = useMemo(() => memoryPort(session), []);
  const remote = useMemo(() => memoryRemote("host-a"), []);
  const [saved, setSaved] = useState<string[]>([]);
  const endpoints = useMemo(
    () => () => ({
      local: localMoveEndpoint({ machineId: "this-mac", port, labelFor: () => "Studio box" }),
      remote,
    }),
    [port, remote],
  );
  const state = teleportStateOf(port.current());
  return (
    <main style={{ maxWidth: 560 }}>
      <div id="band">{state.moved ? <TeleportHeaderBand host={state.host} time="now" /> : null}</div>
      <TeleportMovePanel
        session={port.current()}
        hosts={[{ id: "host-a", name: "Studio box" }]}
        direction={back ? "back" : "out"}
        endpointsFor={endpoints}
        loadRow={async (chatId) => (chatId === port.current().id ? port.current() : null)}
        saveAndOpen={async (next) => {
          setSaved((list) => [...list, next.title]);
        }}
      />
      <p data-testid="saved-count">{saved.length}</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
