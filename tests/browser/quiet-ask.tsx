import { useState } from "react";
import { createRoot } from "react-dom/client";
import { setHomeOpener, type HomeOpenTarget } from "../../src/features/home/model/opener";
import { setWaitingChatsHost } from "../../src/features/hub/model/waitingChats";
import { pendingTranscriptAsk } from "../../src/features/sessions/model/transcriptJump";
import { InboxNeeds } from "../../src/features/needs/ui/InboxNeeds";
import { NeedPane } from "../../src/features/needs/ui/NeedDetail";
import "../../src/styles/index.css";

// Gap A7: the Inbox's Needs you list and the card beside it, as InboxView mounts them in the Hub bundle, on the page's own
// ask ledger (`monocode:dev-local-hub:asks`, which the test seeds). The page keeps what the app would be asked to do:
// the chat it was told to open, the message it was told to open on, and the words it was told to send.
type Seen = { opened: HomeOpenTarget[]; sent: [string, string][] };
const seen: Seen = { opened: [], sent: [] };
Object.assign(window, {
  __quiet: {
    seen,
    asked: (chatId: string) => pendingTranscriptAsk(chatId) ?? null,
  },
});

setHomeOpener((target) => {
  seen.opened.push(target);
});
setWaitingChatsHost({
  liveQuestion: () => undefined,
  respond: () => undefined,
  open: () => undefined,
  send: async (chatId, text) => {
    seen.sent.push([chatId, text]);
    return true;
  },
});

function Harness() {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="flex bg-surface text-content" style={{ width: 1000, height: 640 }}>
      <div className="w-[360px] shrink-0 overflow-y-auto border-r border-stroke">
        <InboxNeeds pick={{ picked, onPick: (item) => setPicked(item.key) }} />
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <NeedPane picked={picked} asksOnly={false}>
          <p className="px-6 py-6 text-[13px] text-content/60">Select a row.</p>
        </NeedPane>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
