// @vitest-environment happy-dom
// r49: one conversation of a room can be deleted (Leadership's too), so a fresh one starts with no old test chat in the
// list or in what the Monos read. The room and its other conversations stay.
import { afterEach, expect, it } from "vitest";
import { deleteConversation, getChat, loadRooms, resetRoomsForTests, roomWritesSettled } from "./hubChats";
import type { RoomBackend } from "./roomStore";

afterEach(() => resetRoomsForTests());

it("takes that conversation only, through the store's own delete", async () => {
  const deleted: string[] = [];
  const conv = (id: string) => ({ id, title: `Example: ${id}`, named: false, createdAt: 1, updatedAt: 1, messages: [], more: false });
  const backend = {
    kind: "app",
    load: async () => ({
      rooms: [{ id: "hub:leadership", projectId: "hub", name: "Leadership team", isDefault: true, memberIds: ["chief-of-staff"],
        seated: true, createdAt: 1, updatedAt: 1, conversations: [conv("old"), conv("new")] }],
    }),
    deleteConversation: async (room: string, id: string) => void deleted.push(`${room}/${id}`),
    import: async () => ({ rooms: 0, conversations: 0, messages: 0 }),
  } as unknown as RoomBackend;
  await loadRooms(backend);
  expect(deleteConversation("hub:leadership", "gone")).toBe(false);
  expect(deleteConversation("hub:leadership", "old")).toBe(true);
  await roomWritesSettled();
  expect(deleted).toEqual(["hub:leadership/old"]);
  expect(getChat("hub:leadership")!.conversations.map((c) => c.id)).toEqual(["new"]);
});
