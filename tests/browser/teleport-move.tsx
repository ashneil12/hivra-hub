import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Session } from "../../src/features/sessions/model/session";
import { TeleportMovePanel } from "../../src/features/connections/ui/TeleportMovePanel";
import { TeleportHeaderBand } from "../../src/features/connections/ui/TeleportNotice";
import { localMoveEndpoint, type LocalChatPort } from "../../src/features/connections/model/teleportLocal";
import { sha256Hex, type ChatSnapshot, type Holds, type MoveEndpoint, type MovePayload } from "../../src/features/connections/model/teleport";
import { teleportStateOf } from "../../src/features/connections/model/teleportState";
import "../../src/styles/index.css";

// WP-177: the start-and-approve panel in a browser, with the local chat store and an in-memory host. The page reads two
// flags: ?busy=1 makes the chat running, ?cannotResume=1 makes the host refuse to resume it.
const params = new URLSearchParams(location.search);
const busy = params.get("busy") === "1";
const cannotResume = params.get("cannotResume") === "1";

const session = {
  id: "fixture-chat",
  harness: "claude",
  model: "test-model-1",
  modelSettings: { effort: "high" },
  runtimeMode: "default",
  title: "Deploy with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX",
  cwd: "/projects/fixture",
  busy,
  blocks: [
    { id: "u1", role: "user", text: "ship it" },
    { id: "a1", role: "assistant", text: "shipped" },
  ],
  providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  queuedMessages: [{ id: "q1", text: "then tell the team", attachments: [] }],
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
    },
    async release() {
      throw new Error("the host is not the source in this fixture");
    },
    async holds(chatId, moveId): Promise<Holds> {
      if (activated.get(chatId) === moveId) return "live";
      return incoming.get(chatId)?.moveId === moveId ? "incoming" : "none";
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
