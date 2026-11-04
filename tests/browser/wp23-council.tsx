import { createRoot } from "react-dom/client";
import { setCouncilEnginesForTests, setCouncilModel } from "../../src/features/council/model/host";
import { ensureBuiltInMonos } from "../../src/features/hub/model/builtInMonos";
import { createChat } from "../../src/features/hub/model/hubChats";
import { GroupChatView } from "../../src/features/hub/ui/GroupChatView";
import "../../src/styles/index.css";

// WP-23 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:). The real room view, with a
// scripted model standing in for the seats. No CLI is launched.

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => (command === "plugin:event|listen" ? 0 : null),
  },
});

localStorage.clear();
ensureBuiltInMonos();
setCouncilEnginesForTests([
  { cli: "claude", family: "Anthropic", label: "Claude Code" },
  { cli: "codex", family: "OpenAI", label: "Codex" },
  { cli: "grok", family: "xAI", label: "Grok Build" },
]);

const stanceTries = new Map<string, number>();
setCouncilModel(async (input) => {
  if (input.round === "blind") return { text: "Example: ship the page, the copy is done.", tokens: 8 };
  if (input.round === "cross") return { text: "Example: the open question is the price.", tokens: 8 };
  if (input.round === "stance") {
    const n = (stanceTries.get(input.seatId) ?? 0) + 1;
    stanceTries.set(input.seatId, n);
    if (input.seatId.endsWith("-3") && n === 1) return { text: "not a stance", tokens: 8 };
    if (input.seatId.endsWith("-3")) return { text: "OPTION: Wait\nCONFIDENCE: 40\nREASON: Example: the price is still open.", tokens: 8 };
    return { text: "OPTION: Ship\nCONFIDENCE: 80\nREASON: Example: the page is ready.", tokens: 8 };
  }
  return {
    text: ["UNRESOLVED:", "Example: the price is still open.", "KILL CRITERIA:", "Example: a refund spike.", "NEXT STEP:", "Example: publish the pricing page.", "MINORITY REPORT:", "Example: one seat would wait."].join("\n"),
    tokens: 8,
  };
});

const room = createChat("hub", "Example: council", []);

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full" data-proof-council>
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <GroupChatView chatId={room.id} projectId="hub" />
    </main>
  </div>,
);
