// @vitest-environment happy-dom
// The room runner in the window, end to end with stand-in sessions: a free Mono takes a room turn as a managed turn; a
// busy one gets the wake in its queue (never refused); Stop takes a waiting wake back out; work a Mono delegated during
// its room turn is recorded and, once its report turn is over, comes back to the room as "X is back".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newSession, type Block, type Session } from "../../features/sessions/model/session";
import type { RoomOrigin } from "../../features/hub/model/roomStore";

vi.mock("../../integrations/harness", () => ({
  canRunHarnessTextPrompt: () => false,
  canSteerHarness: () => true,
  runHarnessTextPrompt: async () => "",
}));
vi.mock("../../platform/tauri/fs", () => ({ homeDir: async () => "/Users/ash" }));
// Ash OS, as the room turns read it: the room's project's memory primer.
const primerCalls: Record<string, unknown>[] = [];
vi.mock("../../features/hub/model/hubTransport", () => ({
  tauriHubTransport: {
    call: async (action: string, payload: Record<string, unknown>) => {
      if (action !== "ash-hub-memory-primer") throw new Error(`no ${action} here`);
      primerCalls.push(payload);
      return { project: String(payload.project), name: "MonoCode Hub", text: "Current memory of MonoCode Hub (hub).\n- Rooms are per project [14 Oct]" };
    },
  },
}));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  localStorage.clear();
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

type Submitted = { sessionId: string; text: string; options: Record<string, unknown> };

async function setup() {
  const team = await import("../../features/hub/model/builtInMonos");
  team.ensureBuiltInMonos();
  const mono = await import("../../features/monos/model/mono");
  const chat = await import("../../features/hub/model/hubChats");
  const { useRoomRunner } = await import("./useRoomRunner");
  const sessionsRef = { current: [] as Session[] };
  const chatOf = (monoId: string) => `mono-${monoId}`;
  for (const id of ["chief-of-staff", "projects-manager", "frank"]) {
    const session = { ...newSession("claude", "/code/hub"), id: chatOf(id) };
    sessionsRef.current.push(session);
    vi.spyOn(mono, "monoForSession").mockImplementation((sid: string) => mono.listMonos().find((m) => chatOf(m.id) === sid));
  }
  const submitted: Submitted[] = [];
  const settle = new Map<string, (text: string) => void>();
  const origins: RoomOrigin[] = [];
  const done: string[] = [];
  let host!: ReturnType<typeof useRoomRunner>;
  let setSessions!: (next: Session[]) => void;
  function Probe() {
    host = useRoomRunner({
      sessions: sessionsRef.current,
      sessionsRef,
      setSessions: (value) => {
        sessionsRef.current = typeof value === "function" ? value(sessionsRef.current) : value;
      },
      submit: (sessionId, text, options) => {
        submitted.push({ sessionId, text, options });
        if (options.onSettled) settle.set(sessionId, (reply) => options.onSettled!({ status: "completed", text: reply }));
        return true;
      },
      openMono: async (monoId) => sessionsRef.current.find((s) => s.id === chatOf(monoId)),
      stop: vi.fn(),
      origins: {
        addOrigin: async (origin) => void origins.push(origin),
        openOrigins: async () => [...origins],
        originDone: async (child) => {
          done.push(child);
          return true;
        },
      },
    });
    return null;
  }
  const render = () => act(() => root.render(createElement(Probe)));
  render();
  setSessions = (next) => {
    sessionsRef.current = next;
    render();
  };
  const room = chat.createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager", "frank"]);
  return { chat, room, sessionsRef, submitted, settle, origins, done, host: () => host, setSessions, chatOf };
}

it("a free Mono's room turn is a managed turn with its quiet line; a busy one gets the wake in its queue", async () => {
  const { chat, room, sessionsRef, submitted, settle, setSessions, chatOf } = await setup();
  // frank is busy in his own chat.
  setSessions(sessionsRef.current.map((s) => (s.id === chatOf("frank") ? { ...s, busy: true } : s)));
  const conv = chat.startConversation(room.id, "frank, is the label in?");
  void chat.requestReply(room.id, conv);
  await vi.waitFor(() => expect(sessionsRef.current.find((s) => s.id === chatOf("frank"))!.queuedMessages).toHaveLength(1));
  const wake = sessionsRef.current.find((s) => s.id === chatOf("frank"))!.queuedMessages![0];
  expect(wake).toMatchObject({ appRequestId: wake.id, monoNote: { kind: "room", from: "Leadership team", ref: room.id, line: "Answered Ash" } });
  expect(wake.text).toContain(`answer in the room with room_post (room "${room.id}")`);
  expect(chat.roomWorking(room.id)).toEqual([{ monoId: "frank", convId: conv, kind: "answer", state: "steered" }]);
  expect(submitted).toEqual([]);
  // Ash asks the host instead: a managed turn, hidden, with its quiet line.
  chat.sendMessage(room.id, "cos, what's next?", conv);
  void chat.requestReply(room.id, conv);
  // The waiting wake is taken back out of frank's queue (Ash turned the room).
  await vi.waitFor(() => expect(sessionsRef.current.find((s) => s.id === chatOf("frank"))!.queuedMessages ?? []).toHaveLength(0));
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  expect(submitted[0]).toMatchObject({
    sessionId: chatOf("chief-of-staff"),
    options: { managed: true, monoNote: { kind: "room", from: "Leadership team", ref: room.id, line: "Answered Ash" } },
  });
  settle.get(chatOf("chief-of-staff"))!("Next: the Pages round.");
  await chat.roomIdle(room.id);
  expect(chat.getChat(room.id)!.conversations[0].messages.at(-1)).toMatchObject({ from: "chief-of-staff", text: "Next: the Pages round." });
});

it("the host's words show in the room while its managed turn writes them, then the post takes their place", async () => {
  const { chat, room, sessionsRef, submitted, settle, setSessions, chatOf } = await setup();
  const conv = chat.startConversation(room.id, "wat now");
  void chat.requestReply(room.id, conv);
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  const requestId = submitted[0].options.appRequestId as string;
  const cos = chatOf("chief-of-staff");
  const write = (text: string) =>
    setSessions(
      sessionsRef.current.map((s) =>
        s.id === cos
          ? {
              ...s,
              busy: true,
              blocks: [
                { id: "p", role: "user", text: submitted[0].text, internal: true, appRequestId: requestId },
                { id: "a", role: "assistant", text, streaming: true },
              ],
            }
          : s,
      ),
    );
  write("Heard you. Waiting on the Tally lead");
  await vi.waitFor(() => expect(chat.roomDrafts(room.id, conv)).toMatchObject([{ monoId: "chief-of-staff", text: "Heard you. Waiting on the Tally lead" }]), { timeout: 2_000 });
  write("Heard you. Waiting on the Tally lead's start-ack.");
  await vi.waitFor(() => expect(chat.roomDrafts(room.id, conv)[0]?.text).toBe("Heard you. Waiting on the Tally lead's start-ack."), { timeout: 2_000 });
  settle.get(cos)!("Heard you. Waiting on the Tally lead's start-ack. Nothing needs you.");
  await chat.roomIdle(room.id);
  expect(chat.roomDrafts(room.id)).toEqual([]);
  expect(chat.getChat(room.id)!.conversations[0].messages.at(-1)).toMatchObject({ from: "chief-of-staff", text: "Heard you. Waiting on the Tally lead's start-ack. Nothing needs you." });
});

it("each seat's room turn starts on the room's project memory, once per conversation of its chat", async () => {
  const { chat, room, submitted, settle, chatOf } = await setup();
  const conv = chat.startConversation(room.id, "wat now");
  void chat.requestReply(room.id, conv);
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  expect(primerCalls.at(-1)).toEqual({ project: "hub" });
  expect(submitted[0].text).toMatch(/^\[MonoCode room\] You are Chief of Staff/);
  expect(submitted[0].text).toContain("This room is the hub project's.");
  expect(submitted[0].text).toContain("<project_memory>");
  expect(submitted[0].text).toContain("- Rooms are per project [14 Oct]");
  settle.get(chatOf("chief-of-staff"))!("Nothing needs you.");
  await chat.roomIdle(room.id);
  chat.sendMessage(room.id, "and now?", conv);
  void chat.requestReply(room.id, conv);
  await vi.waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1].text).not.toContain("<project_memory>");
  settle.get(chatOf("chief-of-staff"))!("Still nothing.");
  await chat.roomIdle(room.id);
});

it("work delegated during a room turn comes back to that room as 'X is back' once its report turn is over", async () => {
  const { chat, room, sessionsRef, submitted, settle, origins, done, host, setSessions, chatOf } = await setup();
  const conv = chat.startConversation(room.id, "research launch platforms in parallel");
  void chat.requestReply(room.id, conv);
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  // During the host's room turn it delegates: the app tells the room host, which records where it came from.
  const cos = sessionsRef.current.find((s) => s.id === chatOf("chief-of-staff"))!;
  host().delegated(cos, { childSessionId: "app-mono-chief-of-staff-q1", title: "Launch shortlist" });
  await vi.waitFor(() => expect(origins).toHaveLength(1));
  expect(origins[0]).toMatchObject({ childSession: "app-mono-chief-of-staff-q1", roomId: room.id, conversationId: conv, monoId: "chief-of-staff", ownerSession: cos.id, title: "Launch shortlist" });
  // Delegated outside a room turn: not recorded.
  host().delegated(sessionsRef.current.find((s) => s.id === chatOf("frank"))!, { childSessionId: "other", title: "x" });
  settle.get(chatOf("chief-of-staff"))!("On it: one worker is researching launch platforms.");
  await chat.roomIdle(room.id);
  // The report turn in the host's own chat, answered.
  const report: Block = {
    id: "r",
    role: "user",
    text: "[MonoCode report] ...",
    internal: true,
    monoSessionCompletion: { sessionId: "app-mono-chief-of-staff-q1", title: "Launch shortlist", status: "completed" },
    startedAt: 1,
  };
  const answer: Block = { id: "a", role: "assistant", text: "Ash, the shortlist is in: stay on Base, Clanker v4 first." };
  setSessions(sessionsRef.current.map((s) => (s.id === cos.id ? { ...s, blocks: [...s.blocks, report, answer] } : s)));
  await vi.waitFor(() => expect(submitted).toHaveLength(2), { timeout: 3_000 });
  expect(submitted[1].text).toContain('Work you delegated from this room has come back: "Launch shortlist"');
  expect(submitted[1].text).toContain("Ash, the shortlist is in");
  settle.get(chatOf("chief-of-staff"))!("Launch shortlist is back: stay on Base, Clanker v4 first. Full write-up in my chat.");
  // No engine for the gate here: the lanes pick, and work that came back always gets frank's check against Ash's words.
  await vi.waitFor(() => expect(submitted).toHaveLength(3));
  expect(submitted[2]).toMatchObject({ sessionId: chatOf("frank") });
  settle.get(chatOf("frank"))!("NO_REPLY");
  await chat.roomIdle(room.id);
  expect(chat.getChat(room.id)!.conversations[0].messages.at(-1)).toMatchObject({ from: "chief-of-staff", pick: { by: "back" } });
  expect(done).toEqual(["app-mono-chief-of-staff-q1"]);
});
