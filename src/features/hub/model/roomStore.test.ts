// @vitest-environment happy-dom
// The rooms move from the window's storage to the app database (src-tauri/src/rooms.rs): copied once, by id, read back
// before the copy counts, the old key left in place; then every change is written through as its own row.
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatMessageKind, GroupChat } from "./types";
import type { ConversationInput, ImportBundle, MessageInput, RoomBackend, RoomInput, RoomSnapshot, StoredMessage } from "./roomStore";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** The app database as rooms.rs keeps it: rooms, seats, threads and messages by id; an import only adds. */
function fakeStore(options: { drop?: string } = {}) {
  const rooms = new Map<string, RoomInput & { createdAt: number }>();
  const threads = new Map<string, ConversationInput & { createdAt: number }>();
  const messages: (MessageInput & { seq: number })[] = [];
  const calls: string[] = [];
  let seq = 0;
  const addMessage = (m: MessageInput) => {
    if (m.id === options.drop) return false;
    if (messages.some((x) => x.roomId === m.roomId && x.id === m.id)) return false;
    messages.push({ ...m, seq: ++seq });
    return true;
  };
  const stored = (m: MessageInput & { seq: number }): StoredMessage => ({
    seq: m.seq,
    id: m.id,
    conversationId: m.conversationId,
    author: m.author,
    kind: m.kind as ChatMessageKind,
    text: m.text,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    meta: m.meta ?? {},
    reactions: m.reactions ?? {},
    createdAt: m.createdAt ?? 0,
  });
  const backend: RoomBackend = {
    kind: "app",
    async load(): Promise<RoomSnapshot> {
      calls.push("load");
      return {
        rooms: [...rooms.values()].map((room) => ({
          ...room,
          updatedAt: room.createdAt,
          conversations: [...threads.values()]
            .filter((t) => t.roomId === room.id)
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((t) => ({
              id: t.id,
              title: t.title,
              named: t.named,
              answeredThrough: t.answeredThrough,
              createdAt: t.createdAt,
              updatedAt: t.createdAt,
              more: false,
              messages: messages.filter((m) => m.roomId === room.id && m.conversationId === t.id).map(stored),
            })),
        })),
      };
    },
    async upsertRoom(room) {
      calls.push(`room ${room.id}`);
      rooms.set(room.id, { ...room, createdAt: rooms.get(room.id)?.createdAt ?? room.createdAt ?? Date.now() });
    },
    async upsertConversation(c) {
      calls.push(`conversation ${c.id}`);
      if (!rooms.has(c.roomId)) throw new Error(`No room ${c.roomId}`);
      threads.set(`${c.roomId}/${c.id}`, { ...c, createdAt: threads.get(`${c.roomId}/${c.id}`)?.createdAt ?? c.createdAt ?? Date.now() });
    },
    async addMessage(m) {
      calls.push(`message ${m.id}`);
      if (!threads.has(`${m.roomId}/${m.conversationId}`)) throw new Error(`No conversation ${m.conversationId}`);
      addMessage(m);
    },
    async updateMessage(patch) {
      calls.push(`update ${patch.id}`);
      const m = messages.find((x) => x.roomId === patch.roomId && x.id === patch.id);
      if (m && patch.reactions) m.reactions = patch.reactions;
      if (m && patch.meta) m.meta = patch.meta;
    },
    async read() {
      return [];
    },
    async import(bundle: ImportBundle) {
      calls.push(`import ${bundle.messages.length}`);
      const report = { rooms: 0, conversations: 0, messages: 0 };
      for (const room of bundle.rooms)
        if (!rooms.has(room.id)) {
          rooms.set(room.id, { ...room, createdAt: room.createdAt ?? 0 });
          report.rooms++;
        }
      for (const c of bundle.conversations)
        if (!threads.has(`${c.roomId}/${c.id}`)) {
          threads.set(`${c.roomId}/${c.id}`, { ...c, createdAt: c.createdAt ?? 0 });
          report.conversations++;
        }
      for (const m of bundle.messages) if (addMessage(m)) report.messages++;
      return report;
    },
    async addOrigin() {},
    async openOrigins() {
      return [];
    },
    async originDone() {
      return true;
    },
  };
  return { backend, rooms, threads, messages, calls };
}

const at = (iso: string) => new Date(iso).getTime();
const t36 = (iso: string) => at(iso).toString(36);

/** What an older build left in the window's storage. */
function legacy(): GroupChat[] {
  return [
    {
      id: "hub:leadership",
      projectId: "hub",
      name: "Leadership team",
      isDefault: true,
      memberIds: ["ada", "ed"],
      conversations: [
        {
          id: `conv-${t36("2026-10-18T10:00:00Z")}-2`,
          when: "Today",
          title: "Pages",
          answeredThrough: "a2",
          messages: [
            { id: "a2", from: "ash", text: "pages next?" },
            { id: `${t36("2026-10-18T10:00:09Z")}ada3`, from: "ada", text: "Yes. PM builds it.", pick: { by: "lanes", why: "x" } },
          ],
        },
        {
          id: "c-old",
          when: "Today",
          title: "Kickoff",
          messages: [
            { id: "a1", from: "ash", text: "hello team" },
            { id: "r1", from: "ed", text: "Logged.", quiet: true },
          ],
        },
      ],
    },
  ];
}

it("the old key's rooms are copied to the app database by id, read back, and the old key stays where it is", async () => {
  const raw = JSON.stringify(legacy());
  localStorage.setItem("monocode:hub-chats", raw);
  localStorage.setItem("monocode:hub-leadership-seated", JSON.stringify(["hub:leadership"]));
  const store = fakeStore();
  const chat = await import("./hubChats");
  await chat.loadRooms(store.backend, at("2026-10-20T09:00:00Z"));
  expect(store.calls).toEqual(["load", "import 4", "load"]);
  const room = chat.getChat("hub:leadership")!;
  expect(room.memberIds).toEqual(["ada", "ed"]);
  expect(room.seated).toBe(true);
  // Newest first, each with the time its id carried, and Ash's words as they were.
  expect(room.conversations.map((c) => c.title)).toEqual(["Pages", "Kickoff"]);
  expect(room.conversations[0].createdAt).toBe(at("2026-10-18T10:00:00Z"));
  expect(room.conversations[0].messages.map((m) => [m.from, m.kind, m.text])).toEqual([
    ["ash", "ash", "pages next?"],
    ["ada", "mono", "Yes. PM builds it."],
  ]);
  expect(room.conversations[0].messages[1].at).toBe(at("2026-10-18T10:00:09Z"));
  expect(room.conversations[0].messages[1].pick).toEqual({ by: "lanes", why: "x" });
  expect(room.conversations[1].messages[1].quiet).toBe(true);
  expect(room.conversations[0].answeredThrough).toBe("a2");
  expect(localStorage.getItem("monocode:hub-chats")).toBe(raw);
  expect(chat.chatSaveProblem()).toBeUndefined();

  // The next launch: the key hasn't changed, so nothing is sent again.
  vi.resetModules();
  const again = await import("./hubChats");
  await again.loadRooms(store.backend);
  expect(store.calls.slice(3)).toEqual(["load"]);
  expect(store.messages).toHaveLength(4);

  // A rolled-back build wrote to the old key meanwhile: only what is new comes across.
  const later = legacy();
  later[0].conversations[1].messages.push({ id: "a3", from: "ash", text: "written by the older build" });
  localStorage.setItem("monocode:hub-chats", JSON.stringify(later));
  vi.resetModules();
  const third = await import("./hubChats");
  await third.loadRooms(store.backend);
  expect(store.messages.map((m) => m.id)).toContain("a3");
  expect(store.messages).toHaveLength(5);
  expect(third.getChat("hub:leadership")!.conversations[1].messages.at(-1)!.text).toBe("written by the older build");
});

it("a copy that didn't all come across says so and is tried again next launch; the old key is never touched", async () => {
  const raw = JSON.stringify(legacy());
  localStorage.setItem("monocode:hub-chats", raw);
  const store = fakeStore({ drop: "r1" });
  const chat = await import("./hubChats");
  await chat.loadRooms(store.backend);
  expect(chat.chatSaveProblem()).toBe("1 item of the old group chats didn't come across. The old copy is kept in this window's storage.");
  expect(localStorage.getItem("monocode:hub-chats-imported")).toBeNull();
  expect(localStorage.getItem("monocode:hub-chats")).toBe(raw);
});

it("after the move, each change is its own row, in order: the room, the thread, then its messages and reactions", async () => {
  const store = fakeStore();
  const chat = await import("./hubChats");
  await chat.loadRooms(store.backend);
  const room = chat.createChat("hub", "Launch week", ["ed"]);
  const conv = chat.startConversation(room.id, "what's left?");
  chat.sendMessage(room.id, "and the copy?", conv);
  const reply = chat.appendMessage(room.id, conv, { from: "ed", kind: "mono", text: "Two cards.", replyTo: `${conv}-1` })!;
  chat.react(room.id, reply.message.id, "ash", "👍");
  chat.addMember(room.id, "cam");
  await chat.roomWritesSettled();
  expect(store.calls.slice(1)).toEqual([
    `room ${room.id}`,
    `conversation ${conv}`,
    `message ${conv}-1`,
    `message ${chat.getChat(room.id)!.conversations[0].messages[1].id}`,
    `message ${reply.message.id}`,
    `update ${reply.message.id}`,
    `room ${room.id}`,
  ]);
  const saved = store.messages.find((m) => m.id === reply.message.id)!;
  expect(saved).toMatchObject({ author: "ed", kind: "mono", replyTo: `${conv}-1`, reactions: { "👍": ["ash"] } });
  expect(store.rooms.get(room.id)!.memberIds).toEqual(["ed", "cam"]);
  // Nothing went to the window's storage.
  expect(localStorage.getItem("monocode:hub-chats")).toBeNull();
});

it("changes made before the database answered wait for it, and a room it already has is never made twice", async () => {
  const store = fakeStore();
  await store.backend.upsertRoom({ id: "hub:leadership", projectId: "hub", name: "Leadership team", isDefault: true, seated: true, memberIds: ["ada"] });
  let release!: () => void;
  const slow: RoomBackend = { ...store.backend, load: () => new Promise((r) => (release = () => void store.backend.load().then(r))) };
  const chat = await import("./hubChats");
  const loading = chat.loadRooms(slow);
  chat.ensureLeadership("hub");
  chat.addMember("hub:leadership", "ed");
  expect(chat.getChat("hub:leadership")).toBeUndefined();
  release();
  await loading;
  await chat.roomWritesSettled();
  expect(chat.getChat("hub:leadership")!.memberIds).toEqual(["ada", "ed"]);
  expect(store.rooms.get("hub:leadership")!.memberIds).toEqual(["ada", "ed"]);
});

it("Ash's last message, unanswered when the app closed, offers Try again instead of silence", async () => {
  const store = fakeStore();
  const now = at("2026-10-20T09:00:00Z");
  await store.backend.upsertRoom({ id: "r", projectId: "hub", name: "Room", isDefault: false, seated: false, memberIds: ["ed"] });
  await store.backend.upsertConversation({ roomId: "r", id: "c", title: "x", named: false, createdAt: now - 60_000 });
  await store.backend.addMessage({ roomId: "r", conversationId: "c", id: "m", author: "ash", kind: "ash", text: "ed?", createdAt: now - 30_000 });
  const chat = await import("./hubChats");
  await chat.loadRooms(store.backend, now);
  expect(chat.replyProblem("r", "c")).toBe("The room's answer was cut off when the app closed. Your message is saved.");
});
