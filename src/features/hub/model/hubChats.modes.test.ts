// @vitest-environment happy-dom
// WP-22: a room's responder mode and goal mode, end to end through hubChats and roomConductor with stand-in runners
// (each Mono's own session) and a stand-in quick model. Nothing here reaches a real model.
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnOutcome, RoomTurnRequest } from "./roomConductor";
import type { RoomDecider } from "./roomModes";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

const TEAM = ["ada", "bo", "ed", "cam"];

async function roster() {
  const { addMono } = await import("../../monos/model/mono");
  for (const [id, name] of [
    ["ada", "Ada"],
    ["bo", "Bo"],
    ["ed", "Ed"],
    ["cam", "Cam"],
    ["dee", "Dee"],
  ] as const)
    addMono({ id, name, mascot: "robot", color: "gray", projects: [] });
}

async function room(mode?: "lead" | "mentions" | "everyone" | "auto", members: string[] = TEAM) {
  await roster();
  const chat = await import("./hubChats");
  const c = chat.createChat("hub", "Leadership team", members);
  if (mode) chat.setRoomResponder(c.id, mode);
  const said = (convId: string) => chat.getChat(c.id)!.conversations.find((x) => x.id === convId)!.messages;
  return { chat, id: c.id, said };
}

type Reply = string | ((request: RoomTurnRequest, n: number) => string | Promise<string>);
function scripted(replies: Record<string, Reply>) {
  const calls: RoomTurnRequest[] = [];
  const count = new Map<string, number>();
  const run = vi.fn(async (request: RoomTurnRequest): Promise<RoomTurnOutcome> => {
    calls.push(request);
    const n = (count.get(request.monoId) ?? 0) + 1;
    count.set(request.monoId, n);
    await new Promise((r) => setTimeout(r, 1));
    const reply = replies[request.monoId] ?? "NO_REPLY";
    return { kind: "reply", text: await (typeof reply === "function" ? reply(request, n) : reply) };
  });
  return { runner: { run, stop: vi.fn() }, calls, who: () => calls.map((c) => c.monoId) };
}
const posts = (msgs: { from: string; kind?: string }[]) => msgs.filter((m) => m.from !== "ash" && m.from !== "app").map((m) => m.from);
const systemLines = (msgs: { from: string; kind?: string; text: string }[]) => msgs.filter((m) => m.kind === "system").map((m) => m.text);
const ALL_SAY = { "ada": "Morning, two things today.", "bo": "Board's green.", ed: "Memory is up to date.", cam: "Nothing on the team." };

it("everyone (the default, and every room from before modes): the lead answers, then each other seat may add a reply", async () => {
  const { chat, id, said } = await room();
  expect(chat.getChat(id)!.responder).toBeUndefined();
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "hey");
  await chat.requestReply(id, conv);
  expect(script.who()[0]).toBe("ada");
  expect([...script.who()].sort()).toEqual([...TEAM].sort());
  expect(posts(said(conv))).toHaveLength(4);
});

it("lead: only the lead answers; an @mention hands it to whoever is mentioned, every one of them", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "hey");
  await chat.requestReply(id, conv);
  expect(script.who()).toEqual(["ada"]);
  expect(said(conv)[1]).toMatchObject({ from: "ada", pick: { by: "lead" } });

  chat.sendMessage(id, "@ed and @cam, anything from you?", conv);
  await chat.requestReply(id, conv);
  expect(script.who().slice(1)).toEqual(["ed", "cam"]);
  const last = said(conv).slice(-2);
  expect(last.map((m) => m.pick?.by)).toEqual(["mention", "mention"]);
  // The second mentioned seat is told it was picked too, not that it is chiming in unasked.
  expect(script.calls.find((c) => c.monoId === "cam")!.prompt).toContain("you were picked to answer it alongside Ed");
});

it("mentions: only who Ash mentions answers; with nobody mentioned nobody does, and the strip says why", async () => {
  const { chat, id, said } = await room("mentions");
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "what's left this week?");
  await chat.requestReply(id, conv);
  expect(script.calls).toHaveLength(0);
  expect(posts(said(conv))).toEqual([]);
  expect(chat.roomStrip(id, conv)).toEqual({ kind: "hint", text: expect.stringContaining("Nobody was mentioned") });
  // Nothing is left looking cut off.
  expect(chat.getChat(id)!.conversations[0].answeredThrough).toBe(said(conv)[0].id);

  chat.sendMessage(id, "Bo, what's left?", conv);
  await chat.requestReply(id, conv);
  expect(script.who()).toEqual(["bo"]);
  expect(chat.roomStrip(id, conv)).toBeUndefined();
});

it("auto: the quick model's pick answers, marked picked automatically; several picks each answer", async () => {
  const { chat, id, said } = await room("auto");
  const decider = vi.fn<RoomDecider>(async () => '{"pick":["ed"],"confidence":0.9}');
  chat.setRoomDecider(decider);
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "did the pricing decision make it into memory?");
  await chat.requestReply(id, conv);
  expect(decider).toHaveBeenCalledTimes(1);
  expect(decider.mock.calls[0][0].prompt).toContain("did the pricing decision make it into memory?");
  expect(script.who()).toEqual(["ed"]);
  expect(said(conv)[1]).toMatchObject({ from: "ed", pick: { by: "auto", why: "picked automatically" } });

  decider.mockResolvedValueOnce('{"pick":["bo","cam"],"confidence":0.8}');
  chat.sendMessage(id, "who's on billing and do we need another Mono for it?", conv);
  await chat.requestReply(id, conv);
  expect(script.who().slice(1)).toEqual(["bo", "cam"]);
  expect(said(conv).slice(-2).every((m) => m.pick?.by === "auto")).toBe(true);
});

it("auto: a mention skips the model", async () => {
  const { chat, id } = await room("auto");
  const decider = vi.fn<RoomDecider>(async () => '{"pick":["ed"],"confidence":0.9}');
  chat.setRoomDecider(decider);
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "@cam quick one");
  await chat.requestReply(id, conv);
  expect(decider).not.toHaveBeenCalled();
  expect(script.who()).toEqual(["cam"]);
});

it("auto falls back to the lead on an error, an unsure or low-confidence answer, and no model, and nobody else chimes in", async () => {
  for (const decider of [
    async () => {
      throw new Error("401 from the provider");
    },
    async () => '{"pick":[],"confidence":0}',
    async () => '{"pick":["ed"],"confidence":0.2}',
    null,
  ] as (RoomDecider | null)[]) {
    vi.resetModules();
    const { chat, id, said } = await room("auto");
    chat.setRoomDecider(decider);
    const script = scripted(ALL_SAY);
    chat.setGroupChatRunner(script.runner);
    const conv = chat.startConversation(id, "hey");
    await chat.requestReply(id, conv);
    expect(script.who()).toEqual(["ada"]);
    expect(said(conv)[1].pick).toMatchObject({ by: "lead", why: expect.stringContaining("Ada leads this room (") });
  }
});

it("auto falls back to the lead on a timeout, within 1.5 seconds, and Ash writing again drops a pick still out", async () => {
  const { chat, id, said } = await room("auto");
  chat.setRoomDecider(() => new Promise(() => undefined));
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const started = Date.now();
  const conv = chat.startConversation(id, "hey");
  expect(chat.roomActive(id, conv)).toBe(false); // nothing yet: the request starts the pick
  const done = chat.requestReply(id, conv);
  expect(chat.roomActive(id, conv)).toBe(true); // the pick counts as the room working (Stop applies)
  await done;
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(1_400);
  expect(waited).toBeLessThan(2_500);
  expect(script.who()).toEqual(["ada"]);
  expect(said(conv)[1].pick?.why).toContain("took too long");

  // A slow pick overtaken by Ash's next message never lands: only his newer message is answered.
  let release: (v: string) => void = () => undefined;
  chat.setRoomDecider(() => new Promise<string>((r) => (release = r)));
  chat.sendMessage(id, "one", conv);
  void chat.requestReply(id, conv);
  const first = release;
  chat.setRoomDecider(async () => '{"pick":["ed"],"confidence":0.9}');
  chat.sendMessage(id, "two", conv);
  const second = chat.requestReply(id, conv);
  first('{"pick":["cam"],"confidence":0.9}');
  await second;
  expect(script.who().slice(1)).toEqual(["ed"]);
}, 10_000);

it("a room's mode is saved with the room and read back", async () => {
  const { chat, id } = await room("mentions");
  const { roomInput, groupChats } = await import("./roomStore");
  const input = roomInput(chat.getChat(id)!);
  expect(input.responder).toBe("mentions");
  const back = groupChats({ rooms: [{ ...input, isDefault: false, seated: false, createdAt: 1, updatedAt: 1, conversations: [] }] });
  expect(back[0].responder).toBe("mentions");
  chat.setRoomResponder(id, "everyone");
  expect(roomInput(chat.getChat(id)!).responder).toBeUndefined();
});

// ---- Goal mode ----------------------------------------------------------------------------------------------------

const control = (c: Record<string, string>) => `<room_control>${JSON.stringify(c)}</room_control>`;

it("goal: the lead chooses who goes next with an instruction, hidden from the room, and stops when it's completed", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted({
    "ada": (_r, n) =>
      n === 1
        ? `Plan: Bo puts the cards up, Ed checks memory.\n${control({ status: "continue", next: "bo", instruction: "Put the three pricing cards on the board." })}`
        : n === 2
          ? control({ status: "continue", next: "ed", instruction: "Check the pricing decision is in memory." })
          : `All set.\n${control({ status: "completed", reason: "the cards are up and memory has the decision" })}`,
    "bo": "Three cards are on the board: copy, Stripe, launch post. Also Ed, have a look.",
    ed: "The pricing decision is in memory, dated today.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Get the pricing page ready to ship");
  await chat.startGoal(id, conv);
  // lead, Bo, lead, Ed, lead: and naming Ed in Bo's post didn't wake him out of turn.
  expect(script.who()).toEqual(["ada", "bo", "ada", "ed", "ada"]);
  expect(script.calls[0].prompt).toContain("turn 1 of at most 13");
  expect(script.calls[1].prompt).toContain('Ada asked you: "Put the three pricing cards on the board."');
  expect(script.calls[3].prompt).toContain('asked you: "Check the pricing decision is in memory."');
  const thread = said(conv);
  expect(thread.every((m) => !m.text.includes("room_control"))).toBe(true);
  expect(posts(thread)).toEqual(["ada", "bo", "ed", "ada"]);
  expect(thread.filter((m) => m.from !== "ash" && m.from !== "app").every((m) => m.pick?.by === "goal")).toBe(true);
  expect(systemLines(thread)).toEqual([
    "Goal mode: Ada leads the room toward this goal, for up to 13 turns.",
    "Goal completed: the cards are up and memory has the decision.",
  ]);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "completed", turns: 5, max: 13 });
  expect(chat.getChat(id)!.conversations[0].answeredThrough).toBe(thread[0].id);
});

it("goal: a run ends on needs input, says so, and Ash's answer carries it on with a fresh budget", async () => {
  const { chat, id, said } = await room();
  const script = scripted({
    "ada": (_r, n) =>
      n === 1
        ? `Two prices are on the table.\n${control({ status: "needs_input", reason: "Ash picks between 9 and 12 a month" })}`
        : `Going with 12.\n${control({ status: "completed", reason: "price set" })}`,
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Set the price");
  await chat.startGoal(id, conv);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "needs_input", reason: "Ash picks between 9 and 12 a month" });
  expect(systemLines(said(conv))).toContain("Goal needs you: Ash picks between 9 and 12 a month.");
  // Nobody else chimed in on the goal, even in an everyone room.
  expect(script.who()).toEqual(["ada"]);

  chat.sendMessage(id, "12", conv);
  await chat.requestReply(id, conv);
  expect(script.who()).toEqual(["ada", "ada"]);
  expect(script.calls[1].prompt).toContain("Ash has written since");
  expect(script.calls[1].prompt).toContain("turn 1 of at most 13");
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "completed" });
});

it("goal: blocked stops the run, and a lead turn with no readable block stops it for Ash", async () => {
  const { chat, id, said } = await room("lead");
  chat.setGroupChatRunner(scripted({ "ada": `Stripe is down.\n${control({ status: "blocked", reason: "Stripe's API is down" })}` }).runner);
  const conv = chat.startConversation(id, "Ship billing");
  await chat.startGoal(id, conv);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "blocked" });
  expect(systemLines(said(conv)).at(-1)).toBe("Goal blocked: Stripe's API is down.");

  vi.resetModules();
  const second = await room("lead");
  second.chat.setGroupChatRunner(scripted({ "ada": "I'll get on it." }).runner);
  const conv2 = second.chat.startConversation(second.id, "Ship billing");
  await second.chat.startGoal(second.id, conv2);
  expect(second.chat.roomGoal(second.id, conv2)).toMatchObject({ state: "needs_input", reason: "Ada didn't say who goes next" });
});

it("goal: the run never takes more than 13 turns, and then waits for Ash", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted({
    "ada": (_r, n) => `Round ${n}.\n${control({ status: "continue", next: "ed", instruction: "Check again." })}`,
    ed: "Checked.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Keep checking forever");
  await chat.startGoal(id, conv);
  expect(script.calls).toHaveLength(13);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "needs_input", turns: 13 });
  expect(systemLines(said(conv)).at(-1)).toBe("Goal needs you: the room used all 13 of its turns.");
});

it("goal: a failed turn blocks the run with a notice; Stop ends it", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted({
    "ada": control({ status: "continue", next: "ed", instruction: "Check." }),
    ed: () => Promise.reject(new Error("usage limit reached")),
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Check memory");
  await chat.startGoal(id, conv);
  expect(said(conv).some((m) => m.kind === "notice" && m.notice?.mono === "ed")).toBe(true);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "blocked", reason: "Ed's turn failed" });

  vi.resetModules();
  const next = await room("lead");
  let release: (v: string) => void = () => undefined;
  next.chat.setGroupChatRunner({ run: () => new Promise<RoomTurnOutcome>((r) => (release = (text) => r({ kind: "reply", text }))), stop: vi.fn() });
  const conv2 = next.chat.startConversation(next.id, "Long goal");
  const running = next.chat.startGoal(next.id, conv2);
  await new Promise((r) => setTimeout(r, 5));
  expect(next.chat.roomStrip(next.id, conv2)).toEqual({ kind: "goal", text: "Working toward the goal · turn 1 of 13" });
  next.chat.stopRoom(next.id, conv2);
  release(control({ status: "continue", next: "ed", instruction: "x" }));
  await running;
  expect(next.chat.roomGoal(next.id, conv2)).toMatchObject({ state: "stopped" });
  expect(next.said(conv2).filter((m) => m.from === "ada")).toHaveLength(0);
});

it("every member's room turn says it is one of several sessions", async () => {
  const { chat, id } = await room();
  const script = scripted(ALL_SAY);
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "hey");
  await chat.requestReply(id, conv);
  expect(script.calls.length).toBe(4);
  for (const call of script.calls) {
    expect(call.prompt).toContain("You are one of several sessions in this room");
    expect(call.wakePrompt).toContain("You are one of several sessions in this room");
  }
});

it("goal: Try again on a failed turn picks the run up from that turn", async () => {
  const { chat, id, said } = await room("lead");
  let fail = true;
  chat.setGroupChatRunner(
    scripted({
      "ada": (_r, n) => (n === 1 ? control({ status: "continue", next: "ed", instruction: "Check." }) : control({ status: "completed", reason: "checked" })),
      ed: () => (fail ? Promise.reject(new Error("usage limit reached")) : "Checked: it's in memory."),
    }).runner,
  );
  const conv = chat.startConversation(id, "Check memory");
  await chat.startGoal(id, conv);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "blocked" });
  fail = false;
  const notice = said(conv).find((m) => m.kind === "notice")!;
  await chat.retryNotice(id, notice.id);
  expect(posts(said(conv))).toEqual(["ed"]);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "completed" });
});

// ---- Review fixes (WP-22 review at 9dafa1f) ------------------------------------------------------------------------

it("goal: a goal whose lead left the room ends with a line, and Ash's next message is answered as usual", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted({
    "ada": control({ status: "needs_input", reason: "Ash picks the price" }),
    "bo": "Here.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Set the price");
  await chat.startGoal(id, conv);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "needs_input" });
  chat.removeMember(id, "ada");
  chat.sendMessage(id, "12", conv);
  await chat.requestReply(id, conv);
  // The room answered (its new lead), the goal is gone and nothing waits.
  expect(script.who()).toEqual(["ada", "bo"]);
  expect(chat.roomGoal(id, conv)).toBeUndefined();
  expect(chat.roomStrip(id, conv)).toBeUndefined();
  expect(chat.roomActive(id, conv)).toBe(false);
});

it("goal: a running goal whose lead leaves mid-run ends as blocked, with a line, instead of hanging", async () => {
  const { chat, id, said } = await room("lead");
  let release: () => void = () => undefined;
  const script = scripted({
    "ada": control({ status: "continue", next: "ed", instruction: "Check." }),
    ed: async () => {
      await new Promise<void>((r) => (release = r));
      return "Checked.";
    },
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Check memory");
  const running = chat.startGoal(id, conv);
  await new Promise((r) => setTimeout(r, 10));
  chat.removeMember(id, "ada");
  release();
  await running;
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "blocked", reason: "Ada isn't in the room any more" });
  expect(systemLines(said(conv)).at(-1)).toBe("Goal blocked: Ada isn't in the room any more.");
  expect(chat.roomActive(id, conv)).toBe(false);
});

it("goal: a busy member's room_post moves the run on; its session failing afterwards changes nothing", async () => {
  const { chat, id, said } = await room("lead");
  let endEd: (end: { status: "failed"; error: string }) => void = () => undefined;
  const leadTurns: string[] = [];
  const runner = {
    run: vi.fn(async (request: RoomTurnRequest): Promise<RoomTurnOutcome> => {
      await new Promise((r) => setTimeout(r, 1));
      if (request.monoId === "ed") {
        // ed is busy in his own chat: the turn goes in as a wake, and he answers with room_post.
        setTimeout(() => chat.postFromMono(id, "ed", "Checked: the decision is in memory."), 2);
        return { kind: "wake", delivery: "queued", done: new Promise((r) => (endEd = r)) };
      }
      leadTurns.push(request.prompt);
      return {
        kind: "reply",
        text: leadTurns.length === 1 ? control({ status: "continue", next: "ed", instruction: "Check memory." }) : `Done.\n${control({ status: "completed", reason: "checked" })}`,
      };
    }),
    stop: vi.fn(),
  };
  chat.setGroupChatRunner(runner);
  const conv = chat.startConversation(id, "Check memory");
  const done = chat.startGoal(id, conv);
  await new Promise((r) => setTimeout(r, 30));
  // ed posted; the run moved on to the lead and completed. Now his own session reports a failure.
  endEd({ status: "failed", error: "usage limit reached" });
  await done;
  expect(posts(said(conv))).toEqual(["ed", "ada"]);
  expect(said(conv).some((m) => m.kind === "notice")).toBe(false);
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "completed" });
});

it("goal: out of turns or blocked, it waits for Continue; a later 'thanks' doesn't restart it; End goal ends it", async () => {
  const { chat, id, said } = await room("lead");
  const script = scripted({
    "ada": (r) => (r.prompt.includes("<room_control>") ? `Round.\n${control({ status: "continue", next: "ed", instruction: "Again." })}` : "You're welcome."),
    ed: "Checked.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "Keep checking");
  await chat.startGoal(id, conv);
  expect(script.calls).toHaveLength(13);
  expect(chat.roomStrip(id, conv)).toEqual({ kind: "goal-waiting", text: "Goal needs you: the room used all 13 of its turns." });

  chat.sendMessage(id, "thanks", conv);
  await chat.requestReply(id, conv);
  // An ordinary answer, not a fresh run of 13.
  expect(script.calls).toHaveLength(14);
  expect(script.calls[13].prompt).not.toContain("<room_control>");
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "needs_input" });

  await chat.continueGoal(id, conv);
  expect(script.calls).toHaveLength(27);
  expect(systemLines(said(conv))).toContain("Ash asked the room to carry on with the goal.");

  chat.endRoomGoal(id, conv);
  expect(chat.roomGoal(id, conv)).toBeUndefined();
  expect(chat.roomStrip(id, conv)).toBeUndefined();
  expect(systemLines(said(conv)).at(-1)).toBe("Goal stopped: you ended it.");
});

it("goal: an unclosed control block is never posted", async () => {
  const { chat, id, said } = await room("lead");
  chat.setGroupChatRunner(scripted({ "ada": 'Working on it.\n<room_control>{"status":"continue","next":"ed"' }).runner);
  const conv = chat.startConversation(id, "Check memory");
  await chat.startGoal(id, conv);
  expect(said(conv).every((m) => !m.text.includes("room_control"))).toBe(true);
  expect(said(conv).find((m) => m.from === "ada")?.text).toBe("Working on it.");
  expect(chat.roomGoal(id, conv)).toMatchObject({ state: "needs_input" });
});

it("a mode the store wouldn't take is saved as everyone, so a bad imported value can't break every save", async () => {
  const { chat, id } = await room();
  const { roomInput } = await import("./roomStore");
  chat.importChats([{ ...chat.getChat(id)!, id: "imported", responder: "loudest" as never }]);
  expect(roomInput(chat.getChat("imported")!).responder).toBeUndefined();
});

it("a goal run's turns stay under the room's posts-without-Ash brake, which goal runs don't check", async () => {
  const { GOAL_MAX_TURNS } = await import("./roomModes");
  const { MONO_POSTS_CEILING } = await import("./roomTurns");
  expect(GOAL_MAX_TURNS).toBeLessThan(MONO_POSTS_CEILING);
});
