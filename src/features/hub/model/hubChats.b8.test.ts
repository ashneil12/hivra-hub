// @vitest-environment happy-dom
// B8 in the app database (rooms.rs through the room backend): a name Ash gave a conversation, and what he attached,
// come back after a restart exactly as they were, and the first message never renames a conversation he named.
import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationInput, MessageInput, RoomBackend, RoomInput, RoomSnapshot, StoredMessage } from "./roomStore";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** A stand-in for the app database with rooms.rs's upsert rules (a conversation's title and named are replaced). */
function memoryStore() {
  const rooms = new Map<string, RoomInput>();
  const convs = new Map<string, ConversationInput>();
  const messages: MessageInput[] = [];
  const backend: RoomBackend = {
    kind: "app",
    load: async (): Promise<RoomSnapshot> => ({
      rooms: [...rooms.values()].map((r) => ({
        ...r,
        seated: !!r.seated,
        createdAt: 1,
        updatedAt: 1,
        conversations: [...convs.values()]
          .filter((c) => c.roomId === r.id)
          .map((c) => ({
            id: c.id,
            title: c.title,
            named: c.named,
            createdAt: c.createdAt ?? 1,
            updatedAt: 1,
            more: false,
            messages: messages
              .filter((m) => m.roomId === r.id && m.conversationId === c.id)
              .map((m, i): StoredMessage => ({ seq: i, id: m.id, conversationId: c.id, author: m.author, kind: m.kind, text: m.text, meta: m.meta ?? {}, reactions: {}, createdAt: m.createdAt ?? 1 })),
          })),
      })),
    }),
    upsertRoom: async (r) => void rooms.set(r.id, r),
    upsertConversation: async (c) => void convs.set(`${c.roomId}/${c.id}`, c),
    addMessage: async (m) => {
      if (!messages.some((x) => x.id === m.id)) messages.push(JSON.parse(JSON.stringify(m)));
    },
    updateMessage: async () => undefined,
    read: async () => [],
    import: async () => ({ rooms: 0, conversations: 0, messages: 0 }),
    addOrigin: async () => undefined,
    openOrigins: async () => [],
    originDone: async () => true,
  };
  return backend;
}

it("a named new conversation and a renamed one keep their names, and the attachments their paths, across a restart", async () => {
  const store = memoryStore();
  let chat = await import("./hubChats");
  await chat.loadRooms(store);
  const room = chat.createChat("hub", "Leadership Board", ["chief-of-staff"]);
  const photo = { id: "p", name: "hud.png", mimeType: "image/png", kind: "image" as const, size: 9, path: "/tmp/monocode-attachments/hud.png" };
  const named = chat.startConversation(room.id, "the hud looks off on the external monitor", { title: "HUD crispness", attachments: [photo] });
  const other = chat.startConversation(room.id, "what needs me today");
  chat.renameConversation(room.id, other, "Today's asks");
  chat.sendMessage(room.id, "also the dodge timing", other);
  await chat.roomWritesSettled();

  // Restart: a fresh window reads the store.
  vi.resetModules();
  chat = await import("./hubChats");
  await chat.loadRooms(store);
  const convs = chat.getChat(room.id)!.conversations;
  expect(convs.find((c) => c.id === named)).toMatchObject({ title: "HUD crispness", named: true });
  expect(convs.find((c) => c.id === named)!.messages[0].attachments).toEqual([photo]);
  expect(convs.find((c) => c.id === other)).toMatchObject({ title: "Today's asks", named: true });
  // After the restart, more messages still never rename them.
  chat.sendMessage(room.id, "ok next thing", other);
  expect(chat.getChat(room.id)!.conversations.find((c) => c.id === other)!.title).toBe("Today's asks");
});
