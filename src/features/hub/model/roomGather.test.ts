// @vitest-environment happy-dom
// WP-245: a question several seats answer comes back as one block: the answers are held until every seat has answered
// (or the wait ran out), then land together in seat order, and the room names who didn't answer. Stand-in runners only;
// nothing here reaches a real model.
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnOutcome, RoomTurnRequest } from "./roomConductor";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

async function room() {
  const { addMono } = await import("../../monos/model/mono");
  for (const [id, name] of [
    ["ada", "Ada"],
    ["bo", "Bo"],
    ["ed", "Ed"],
  ] as const)
    addMono({ id, name, mascot: "robot", color: "gray", projects: [] });
  const chat = await import("./hubChats");
  const conductor = await import("./roomConductor");
  const c = chat.createChat("hub", "Launch team", ["ada", "bo", "ed"]);
  chat.setRoomResponder(c.id, "lead");
  const said = (convId: string) => chat.getChat(c.id)!.conversations.find((x) => x.id === convId)!.messages;
  return { chat, conductor, id: c.id, said };
}

type Gate = { open: () => void; wait: Promise<void> };
function gate(): Gate {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

/** Each seat answers when its gate opens; a seat with no gate never answers in the test. */
function runner(replies: Record<string, string>, gates: Record<string, Gate>) {
  const run = vi.fn(async (request: RoomTurnRequest): Promise<RoomTurnOutcome> => {
    const g = gates[request.monoId];
    if (g) await g.wait;
    else await new Promise(() => undefined);
    return { kind: "reply", text: replies[request.monoId] ?? "NO_REPLY" };
  });
  return { run, stop: vi.fn() };
}

const posts = (msgs: { from: string; kind?: string }[]) => msgs.filter((m) => m.from !== "ash" && m.from !== "app");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("holds the first answers until every mentioned seat has answered, then posts them together in seat order", async () => {
  const { chat, conductor, id, said } = await room();
  const gates = { ada: gate(), bo: gate(), ed: gate() };
  chat.setGroupChatRunner(runner({ ada: "Thursday.", bo: "Friday.", ed: "Thursday works." }, gates));
  const conv = chat.startConversation(id, "@Ada @Bo @Ed when do we ship?");
  const done = chat.requestReply(id, conv);
  // Bo answers first, then Ada: nothing is posted while Ed still writes; both show as held.
  gates.bo.open();
  await flush();
  gates.ada.open();
  await vi.waitFor(() => expect(conductor.roomDrafts(id, conv).filter((d) => d.held)).toHaveLength(2));
  expect(posts(said(conv))).toEqual([]);
  gates.ed.open();
  await done;
  const answers = posts(said(conv));
  expect(answers.map((m) => m.from)).toEqual(["ada", "bo", "ed"]);
  expect(new Set(answers.map((m) => (m as { gather?: string }).gather)).size).toBe(1);
  expect(answers[0]).toHaveProperty("gather");
  expect(said(conv).some((m) => m.kind === "system")).toBe(false);
});

it("with one member missing, posts the others when the wait runs out and names who didn't answer", async () => {
  const { chat, conductor, id, said } = await room();
  conductor.setRoomGatherTimeout(60);
  const gates = { ada: gate(), bo: gate() };
  chat.setGroupChatRunner(runner({ ada: "Thursday.", bo: "Friday." }, gates));
  const conv = chat.startConversation(id, "@Ada @Bo @Ed when do we ship?");
  void chat.requestReply(id, conv);
  gates.ada.open();
  gates.bo.open();
  await vi.waitFor(() => expect(conductor.roomDrafts(id, conv).filter((d) => d.held)).toHaveLength(2));
  expect(posts(said(conv))).toEqual([]);
  await vi.waitFor(() => expect(posts(said(conv)).map((m) => m.from)).toEqual(["ada", "bo"]));
  expect(said(conv).filter((m) => m.kind === "system").map((m) => m.text)).toEqual(["No answer from Ed within a second."]);
  expect(conductor.roomDrafts(id, conv).filter((d) => d.held)).toHaveLength(0);
  conductor.resetConductorForTests();
});

it("lands what is held at once when Ash writes again, before his new message is answered", async () => {
  const { chat, conductor, id, said } = await room();
  const gates = { ada: gate(), bo: gate() };
  chat.setGroupChatRunner(runner({ ada: "Thursday.", bo: "Friday." }, gates));
  const conv = chat.startConversation(id, "@Ada @Ed when do we ship?");
  void chat.requestReply(id, conv);
  gates.ada.open();
  await vi.waitFor(() => expect(conductor.roomDrafts(id, conv).filter((d) => d.held)).toHaveLength(1));
  chat.sendMessage(id, "@Bo you too?", conv);
  void chat.requestReply(id, conv);
  await vi.waitFor(() => expect(posts(said(conv)).map((m) => m.from)).toContain("ada"));
  // Nothing timed out, so nobody is named.
  expect(said(conv).some((m) => m.kind === "system")).toBe(false);
  conductor.resetConductorForTests();
});

it("can be turned off: each answer posts as it comes", async () => {
  const { chat, conductor, id, said } = await room();
  conductor.setRoomGathering(false);
  const gates = { ada: gate() };
  chat.setGroupChatRunner(runner({ ada: "Thursday." }, gates));
  const conv = chat.startConversation(id, "@Ada @Ed when do we ship?");
  void chat.requestReply(id, conv);
  gates.ada.open();
  await vi.waitFor(() => expect(posts(said(conv)).map((m) => m.from)).toEqual(["ada"]));
  expect(posts(said(conv))[0]).not.toHaveProperty("gather");
  conductor.resetConductorForTests();
});
