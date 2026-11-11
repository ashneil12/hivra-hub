import { createRoot } from "react-dom/client";
import { createChat, getChat, setGroupChatRunner, setRoomDecider } from "../../src/features/hub/model/hubChats";
import { addMono, listMonos } from "../../src/features/monos/model/mono";
import { GroupChatView } from "../../src/features/hub/ui/GroupChatView";
import { RoomResponder } from "../../src/features/hub/ui/RoomResponder";
import { useHubChatsVersion } from "../../src/features/hub/model/hubChats";
import "../../src/styles/index.css";

// WP-22 proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): the real room view with a
// stand-in for each Mono's session and no quick model. The lead's goal turn asks Ash to choose, so a goal run ends on
// needs input.

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string) => (command === "plugin:event|listen" ? 0 : null),
  },
});

localStorage.clear();
addMono({ id: "ada", name: "Ada", mascot: "crab", color: "hsl(142 55% 50%)", projects: [] });
addMono({ id: "bo", name: "Bo", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] });
addMono({ id: "ed", name: "ed", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] });
const room = createChat("hub", "Example: launch room", ["ada", "bo", "ed"]);
setRoomDecider(null);
setGroupChatRunner({
  run: async (request) => {
    await new Promise((r) => setTimeout(r, 300));
    if (request.monoId === "ada" && request.prompt.includes("<room_control>"))
      return {
        kind: "reply",
        text: 'Example: two prices are on the table, 9 or 12 a month.\n<room_control>{"status":"needs_input","reason":"Ash picks between 9 and 12 a month"}</room_control>',
      };
    return { kind: "reply", text: request.monoId === "ada" ? "Example: morning." : "NO_REPLY" };
  },
  stop: () => undefined,
});
Object.assign(window, { __wp22Room: () => getChat(room.id) });

/** The team's settings as Settings, Teams shows them (they left the chat's side panel on 11 Nov), beside the room. */
function TeamSettings() {
  useHubChatsVersion();
  const chat = getChat(room.id);
  if (!chat) return null;
  return <RoomResponder chat={chat} members={listMonos().filter((m) => chat.memberIds.includes(m.id))} />;
}

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full" data-proof-room>
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <GroupChatView chatId={room.id} projectId="hub" />
    </main>
    <aside className="w-72 shrink-0 border-l border-stroke p-3" data-proof-team-settings>
      <TeamSettings />
    </aside>
  </div>,
);
