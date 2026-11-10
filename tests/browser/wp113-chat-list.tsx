import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatListInboxPanel } from "../../src/features/sessions/ui/ChatListInbox";
import type { ChatAttention } from "../../src/features/sessions/model/chatListInbox";
import "../../src/styles/index.css";

const chats = [
  { id: "alpha", title: "Alpha", updatedAt: 100 },
  { id: "beta", title: "Beta", updatedAt: 200 },
];

const needsAlpha: ChatAttention = {
  needsApproval: true,
  hasQuestion: false,
  failed: false,
  needsPerson: true,
  ownMessage: "none",
  lastUserMessageAt: null,
};

function Fixture() {
  const [needsYou, setNeedsYou] = useState(false);
  const attention = useMemo(
    () => (needsYou ? new Map([["alpha", needsAlpha]]) : undefined),
    [needsYou],
  );
  return (
    <div className="text-content">
      <button type="button" onClick={() => setNeedsYou(true)}>
        Needs you
      </button>
      <ChatListInboxPanel chats={chats} attention={attention} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
