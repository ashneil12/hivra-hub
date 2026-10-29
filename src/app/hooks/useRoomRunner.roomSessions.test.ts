// @vitest-environment happy-dom
// r52: each room conversation has its own session per Mono, like separate Claude Code chats. A room's turns never run in
// the Mono's 1:1 chat; a second turn in the same conversation goes back to that conversation's session; deleting the
// conversation deletes those sessions, so nothing said there reaches the next room prompt.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../features/sessions/model/session";

vi.mock("../../integrations/harness", () => ({
  canRunHarnessTextPrompt: () => false,
  canSteerHarness: () => true,
  runHarnessTextPrompt: async () => "",
}));
vi.mock("../../platform/tauri/fs", () => ({ homeDir: async () => "/Users/ash" }));
vi.mock("../../features/hub/model/hubTransport", () => ({
  tauriHubTransport: { call: async (action: string) => Promise.reject(new Error(`no ${action} here`)) },
}));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const SECRET = "PELICAN-7";

async function setup() {
  const team = await import("../../features/hub/model/builtInMonos");
  team.ensureBuiltInMonos();
  const mono = await import("../../features/monos/model/mono");
  const workspace = await import("../../features/monos/model/monoWorkspace");
  const chat = await import("../../features/hub/model/hubChats");
  const { useRoomRunner } = await import("./useRoomRunner");
  const sessionsRef = { current: [] as Session[] };
  const SEATS = ["chief-of-staff", "frank"];
  // Each Mono's long 1:1 chat from before r52, with what Ash said there.
  for (const id of SEATS) {
    const own: Session = { ...newSession("claude", "/code/hub"), id: `own-${id}` };
    own.blocks = [{ id: `b-${id}`, role: "user", text: "Ash's 1:1 message" } as Block];
    sessionsRef.current.push(own);
    mono.saveMonoSessionId(id, own.id);
  }
  const submitted: { sessionId: string; text: string }[] = [];
  const dropped: string[] = [];
  const roomHost = {
    home: async () => "/Users/ash",
    load: async (id: string) => sessionsRef.current.find((s) => s.id === id),
    create: (cwd: string) => newSession("claude", cwd),
    add: (s: Session) => void (sessionsRef.current = [...sessionsRef.current, s]),
  };
  function Probe() {
    useRoomRunner({
      sessions: sessionsRef.current,
      sessionsRef,
      setSessions: (value) => {
        sessionsRef.current = typeof value === "function" ? value(sessionsRef.current) : value;
      },
      submit: (sessionId, text, options) => {
        submitted.push({ sessionId, text });
        const reply = sessionId.startsWith("own-") ? "WRONG CHAT" : text.includes("This is your one turn") ? "NO_REPLY" : text.includes("is the label in") ? "The label is in: commit def5678." : "Noted.";
        // The chat keeps the prompt as its hidden user turn and the answer after it, as the app's does.
        sessionsRef.current = sessionsRef.current.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                blocks: [
                  ...s.blocks,
                  { id: `p${submitted.length}`, role: "user", text, internal: true, appRequestId: options.appRequestId, monoNote: options.monoNote } as Block,
                  { id: `r${submitted.length}`, role: "assistant", text: reply } as Block,
                ],
              }
            : s,
        );
        queueMicrotask(() => options.onSettled?.({ status: "completed", text: reply }));
        return true;
      },
      openMono: async (monoId) => sessionsRef.current.find((s) => s.id === `own-${monoId}`),
      openRoom: (monoId, chatId, convId) => workspace.ensureMonoRoomSession(monoId, chatId, convId, roomHost),
      dropSession: async (id) => {
        dropped.push(id);
        sessionsRef.current = sessionsRef.current.filter((s) => s.id !== id);
        return true;
      },
      stop: vi.fn(),
    });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  const room = chat.createChat("hub", "Leadership team", SEATS);
  return { chat, mono, room, sessionsRef, submitted, dropped };
}

it("room turns run in a session of their own per conversation per Mono, never in its 1:1 chat", async () => {
  const { chat, mono, room, sessionsRef, submitted } = await setup();
  const a = chat.startConversation(room.id, `cos, the word for today is ${SECRET}`);
  await chat.requestReply(room.id, a);
  await chat.roomIdle(room.id);
  const cosA = mono.monoRoomSession("chief-of-staff", room.id, a)!;
  expect(cosA).toBeTruthy();
  expect(cosA).not.toBe("own-chief-of-staff");
  expect(mono.findMono("chief-of-staff")!.sessionId).toBe("own-chief-of-staff");
  expect(mono.monoForSession(cosA)?.id).toBe("chief-of-staff");
  expect(mono.isMonoSession(cosA)).toBe(true);
  expect(submitted.some((s) => s.sessionId.startsWith("own-"))).toBe(false);
  // The 1:1 chats got nothing from the room.
  for (const id of ["own-chief-of-staff", "own-frank"])
    expect(sessionsRef.current.find((s) => s.id === id)!.blocks.map((b) => b.text)).toEqual(["Ash's 1:1 message"]);
  // A second turn in the same conversation goes back to its session.
  chat.sendMessage(room.id, "cos, and after that?", a);
  await chat.requestReply(room.id, a);
  await chat.roomIdle(room.id);
  expect(new Set(submitted.filter((s) => s.text.includes("after that")).map((s) => s.sessionId)).has(cosA)).toBe(true);
  expect(mono.monoRoomSession("chief-of-staff", room.id, a)).toBe(cosA);
});

it("a deleted room conversation's text doesn't reach the next room prompt", async () => {
  const { chat, mono, room, sessionsRef, submitted, dropped } = await setup();
  const a = chat.startConversation(room.id, `cos, the word for today is ${SECRET}`);
  await chat.requestReply(room.id, a);
  await chat.roomIdle(room.id);
  const gone = mono.monoRoomSessionsOf(room.id, a).map((x) => x.sessionId);
  expect(gone).toContain(mono.monoRoomSession("chief-of-staff", room.id, a));
  expect(sessionsRef.current.filter((s) => gone.includes(s.id)).some((s) => s.blocks.some((b) => b.text.includes(SECRET)))).toBe(true);

  chat.deleteConversation(room.id, a);
  await vi.waitFor(() => expect([...dropped].sort()).toEqual([...gone].sort()));
  await vi.waitFor(() => expect(mono.monoRoomSession("chief-of-staff", room.id, a)).toBeUndefined());
  expect(mono.monoForSession(gone[0])).toBeUndefined();

  const before = submitted.length;
  const b = chat.startConversation(room.id, "cos, what's next?");
  await chat.requestReply(room.id, b);
  await chat.roomIdle(room.id);
  const next = submitted.slice(before);
  expect(next.length).toBeGreaterThan(0);
  for (const turn of next) {
    expect(gone).not.toContain(turn.sessionId);
    expect(turn.text).not.toContain(SECRET);
    // Nothing in the session it ran in has it either.
    expect(sessionsRef.current.find((s) => s.id === turn.sessionId)!.blocks.map((x) => x.text).join("\n")).not.toContain(SECRET);
  }
  expect(sessionsRef.current.some((s) => s.blocks.some((x) => x.text.includes(SECRET)))).toBe(false);
});

// r62 (Alfred's 0.16.3 A2 run): steering the room's wake into a Mono's busy 1:1 put the room prompt into the 1:1, and the
// answer never reached the room. The room's own session takes the turn, even while the 1:1 is mid-reply, and it posts.
it("a Mono mid-reply in its 1:1 still answers in the room, from the room's session; the 1:1 gets nothing", async () => {
  const { chat, mono, room, sessionsRef, submitted } = await setup();
  sessionsRef.current = sessionsRef.current.map((s) => (s.id === "own-frank" ? { ...s, busy: true } : s));
  const a = chat.startConversation(room.id, "frank, is the label in?");
  await chat.requestReply(room.id, a);
  await chat.roomIdle(room.id);
  const own = sessionsRef.current.find((s) => s.id === "own-frank")!;
  expect(own.queuedMessages ?? []).toEqual([]);
  expect(own.blocks.map((b) => b.text)).toEqual(["Ash's 1:1 message"]);
  expect(submitted.some((s) => s.sessionId.startsWith("own-"))).toBe(false);
  const frankRoom = mono.monoRoomSession("frank", room.id, a)!;
  expect(frankRoom).toBeTruthy();
  expect(submitted.some((s) => s.sessionId === frankRoom)).toBe(true);
  const said = chat.getChat(room.id)!.conversations.find((x) => x.id === a)!.messages;
  expect(said.some((m) => m.from === "frank" && m.text === "The label is in: commit def5678.")).toBe(true);
});

it("deleting a whole room lets go of every conversation's sessions", async () => {
  const { chat, mono, sessionsRef, dropped } = await setup();
  const other = chat.createChat("hub", "Pricing", ["chief-of-staff"]);
  const c = chat.startConversation(other.id, "cos, price?");
  await chat.requestReply(other.id, c);
  await chat.roomIdle(other.id);
  const sid = mono.monoRoomSession("chief-of-staff", other.id, c)!;
  expect(sid).toBeTruthy();
  chat.deleteChat(other.id);
  await vi.waitFor(() => expect(dropped).toContain(sid));
  await vi.waitFor(() => expect(mono.monoRoomSessionsOf(other.id)).toEqual([]));
  expect(sessionsRef.current.some((s) => s.id === sid)).toBe(false);
});

// r62 (A5): replies to a new room landed in the older Leadership room. Each room's turn answers in the room that asked.
it("a reply goes to the room that asked, even when another room is newer and has the same Monos", async () => {
  const { chat, sessionsRef } = await setup();
  const marketing = chat.createChat("hub", "Marketing", ["chief-of-staff", "frank"]);
  const m = chat.startConversation(marketing.id, "frank, is the label in?");
  await chat.requestReply(marketing.id, m);
  await chat.roomIdle(marketing.id);
  const inMarketing = chat.getChat(marketing.id)!.conversations.flatMap((c) => c.messages);
  expect(inMarketing.some((x) => x.from === "frank" && x.text === "The label is in: commit def5678.")).toBe(true);
  const leadership = chat.allChats().filter((c) => c.id !== marketing.id);
  for (const other of leadership) expect(other.conversations.flatMap((c) => c.messages).some((x) => x.from === "frank")).toBe(false);
  expect(sessionsRef.current.find((s) => s.id === "own-frank")!.blocks.map((b) => b.text)).toEqual(["Ash's 1:1 message"]);
});

// r62: while frank's room session is still busy with an earlier room turn, the next one waits in that session's queue
// (never the 1:1's) and is not dropped.
it("a room turn for a Mono whose room session is busy waits in that session's queue, never the 1:1's", async () => {
  const { chat, mono, room, sessionsRef } = await setup();
  const a = chat.startConversation(room.id, "frank, is the label in?");
  await chat.requestReply(room.id, a);
  await chat.roomIdle(room.id);
  const frankRoom = mono.monoRoomSession("frank", room.id, a)!;
  sessionsRef.current = sessionsRef.current.map((s) => (s.id === frankRoom || s.id === "own-frank" ? { ...s, busy: true } : s));
  chat.sendMessage(room.id, "frank, and the colour?", a);
  void chat.requestReply(room.id, a);
  await vi.waitFor(() => expect(sessionsRef.current.find((s) => s.id === frankRoom)!.queuedMessages?.length).toBe(1));
  expect(sessionsRef.current.find((s) => s.id === "own-frank")!.queuedMessages ?? []).toEqual([]);
});

// r62 (event 3): a wake queued in a busy session says so, its last event following the work it waits behind; once in,
// it reports its own steps. Both from the session's stream.
it("a queued room wake reports 'Queued behind its current reply', then its own steps once delivered", async () => {
  const { roomWakeActivity } = await import("./useRoomRunner");
  const base = { id: "s", harness: "claude", cwd: "/repo", busy: true } as unknown as Session;
  const work: Block[] = [
    { id: "u1", role: "user", text: "Ash's 1:1 message" },
    { id: "t1", role: "tool", text: "Read", tool: { kind: "read", status: "in_progress", preview: { kind: "read", path: "/repo/src/app.tsx" }, startedAt: 1_000, updatedAt: 1_000 } },
  ];
  const queued = { ...base, blocks: work, queuedMessages: [{ id: "wake-1", text: "room" }] } as unknown as Session;
  const a = roomWakeActivity(queued, "wake-1", 2_000)!;
  expect(a.label).toBe("Queued behind its current reply");
  expect(a.key).toBe("queued:wake-1");
  const more = { ...queued, blocks: [...work.slice(0, 1), { ...work[1], tool: { ...work[1].tool!, updatedAt: 50_000 } }] } as Session;
  expect(roomWakeActivity(more, "wake-1", 50_000)!.lastEventAt).toBe(50_000);
  const delivered = {
    ...base,
    queuedMessages: [],
    blocks: [...work, { id: "u2", role: "user", text: "room", internal: true, appRequestId: "wake-1" }, { id: "t2", role: "tool", text: "Read", tool: { kind: "read", status: "in_progress", preview: { kind: "read", path: "/repo/src/room.tsx" } } }],
  } as unknown as Session;
  expect(roomWakeActivity(delivered, "wake-1", 60_000)!.label).toBe("Reading room.tsx");
  expect(roomWakeActivity({ ...base, blocks: [], queuedMessages: [] } as unknown as Session, "wake-1", 60_000)).toBeUndefined();
});
