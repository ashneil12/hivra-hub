// WP-245 proof fixture (browser preview, made-up data labelled Example:): a worker chat's queue that says why each
// message waits, and a team room where a question to three first mates comes back as one gathered block.
import { createRoot } from "react-dom/client";
import { MessageQueue } from "../../src/features/sessions/ui/MessageQueue";
import { queueWaitReasons } from "../../src/features/sessions/model/queueWaitReason";
import type { QueuedMessage, Session } from "../../src/features/sessions/model/session";
import {
  appendMessage,
  createChat,
  getChat,
  setGroupChatRunner,
  setRoomDecider,
  setRoomResponder,
} from "../../src/features/hub/model/hubChats";
import * as conductor from "../../src/features/hub/model/roomConductor";
import { addMono } from "../../src/features/monos/model/mono";
import { GroupChatView } from "../../src/features/hub/ui/GroupChatView";
import "../../src/styles/index.css";

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => (command === "plugin:event|listen" ? 0 : null),
  },
});

// ---- The queue ----------------------------------------------------------------------------------------------------

const queued = (id: string, text: string): QueuedMessage => ({ id, text, attachments: [] });
const busy = {
  id: "worker",
  busy: true,
  turnReady: true,
  blocks: [{ id: "ask", role: "approval", text: "", approval: { requestId: 1 } }],
  queuedMessages: [
    queued("q1", "Example: also run the linter"),
    queued("q2", "Example: then open the pull request"),
    queued("q3", "Example: and tag the release"),
  ],
} as unknown as Session;
const limited = {
  id: "limited",
  busy: false,
  blocks: [],
  usageLimit: { resetsAt: new Date(2026, 10, 11, 14, 0).getTime() },
  queuedMessages: [queued("l1", "Example: carry on with the docs")],
} as unknown as Session;

function Queue({ session, label }: { session: Session; label: string }) {
  const reasons = queueWaitReasons(session, new Date(2026, 10, 11, 12, 0).getTime());
  return (
    <section className="w-[420px]" data-proof-queue={label}>
      <div className="px-2 pb-1 text-xs text-content/60">{label}</div>
      <MessageQueue messages={session.queuedMessages ?? []} status={session.queueStatus} waitReasons={reasons} onDelete={() => {}} onEdit={() => {}} />
    </section>
  );
}

// ---- The room -----------------------------------------------------------------------------------------------------

localStorage.clear();
addMono({ id: "ada", name: "Ada", mascot: "crab", color: "hsl(142 55% 50%)", projects: [] });
addMono({ id: "bo", name: "Bo", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] });
addMono({ id: "ed", name: "Ed", mascot: "robot", color: "hsl(30 60% 55%)", projects: [] });
const room = createChat("hub", "Example: launch team", ["ada", "bo", "ed"]);
// The lead answers unless Ash names seats; he names all three, so all three answer.
setRoomResponder(room.id, "lead");
setRoomDecider(null);
// After WP-245: answers that don't all arrive within this long land without the missing one. Absent before it.
(conductor as unknown as { setRoomGatherTimeout?: (ms: number) => void }).setRoomGatherTimeout?.(1_500);
setGroupChatRunner({
  run: async (request) => {
    if (request.monoId === "ed") return new Promise(() => undefined);
    await new Promise((r) => setTimeout(r, request.monoId === "ada" ? 100 : 700));
    return {
      kind: "reply",
      text: request.monoId === "ada" ? "Example: ship on Thursday; the docs are ready." : "Example: Friday is safer. Two pricing pages still need a review.",
    };
  },
  stop: () => undefined,
});
Object.assign(window, {
  __wp245Ask: () => {
    appendMessage(room.id, undefined, { from: "ash", kind: "ash", text: "Example: @Ada @Bo @Ed when do we ship?" });
    void conductor.requestReply(room.id);
  },
  __wp245Room: () => getChat(room.id),
});

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full gap-6 p-4">
    <div className="flex flex-col gap-6" data-proof-queues>
      <Queue session={busy} label="Example: a worker that waits on your approval" />
      <Queue session={limited} label="Example: a chat at its usage limit" />
    </div>
    <main className="flex h-full min-w-0 flex-1 flex-col rounded-lg border border-stroke" data-proof-room>
      <GroupChatView chatId={room.id} projectId="hub" />
    </main>
  </div>,
);
