import { createRoot } from "react-dom/client";
import { ensureBuiltInMonos } from "../../src/features/hub/model/builtInMonos";
import { appendMessage, createChat, startConversation } from "../../src/features/hub/model/hubChats";
import { draftMono } from "../../src/features/selfBuild/model/monoMake";
import { GroupChatView } from "../../src/features/hub/ui/GroupChatView";
import { ChangeBar } from "../../src/features/selfBuild/ui/ChangeBar";
import "../../src/styles/index.css";

// Round 29 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): the leadership room where
// Chief of Staff drafted a new Mono. Its card is a message in the conversation, after the reply that offered it, not a
// card floating over the chat; its skills read by their plain names. The window-wide ChangeBar is mounted too, to show
// it no longer floats the card.

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
const room = createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager", "alfred"]);
const conv = startConversation(room.id, "Example: make a marketing chat with CoS and PM, and add a new Mono for X posts");
appendMessage(room.id, conv, {
  from: "chief-of-staff",
  kind: "mono",
  text: "Example: I've opened the Marketing chat with you, me and Projects Manager. For X posts I've drafted a new Mono, Postie: it drafts your posts and hands them to me, and never posts. Say yes here to make it.",
});
appendMessage(room.id, conv, {
  from: "projects-manager",
  kind: "mono",
  text: "Example: the Marketing chat is real: you, Chief of Staff and me. Nothing goes on the board until you answer.",
});
draftMono(
  {
    name: "Example: Postie",
    role: "Drafts X posts",
    who: "I'm Postie. I draft your X posts, casual, and hand them to Chief of Staff. Drafts only. I never post.",
    watchFor: "Anything that would post, reply or schedule on X, or a draft that invents a number or a launch.",
    skills: ["ash-copywriting", "human-writing"],
  },
  { monoId: "chief-of-staff", name: "Chief of Staff", projects: [] },
  Date.now(),
  new Set(["ash-copywriting", "human-writing"]),
  { room: room.id, conv },
);

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full" data-proof-room>
    <aside className="h-full w-[220px] border-r border-content/10 bg-background-sidebar" />
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <GroupChatView chatId={room.id} projectId="hub" />
    </main>
    <ChangeBar />
  </div>,
);
