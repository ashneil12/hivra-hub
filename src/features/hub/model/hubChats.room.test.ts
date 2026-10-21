// @vitest-environment happy-dom
// The room taking turns the Grok-era way, end to end through hubChats and roomConductor with a stand-in runner (each
// Mono's own session) and router (the small model): the host answers Ash first; the others add at most one reply to his
// message; the Monos then talk among themselves for as long as they name each other; progress guards and a ceiling
// pause them for Ash; Ash's message turns the room at once; Stop and keep going; busy Monos answer from their own chat;
// nothing fails quietly.
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnOutcome, RoomTurnRequest } from "./roomConductor";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const TEAM = ["chief-of-staff", "projects-manager", "frank", "alfred"];

async function room(members: string[] = TEAM) {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos(); // the roster gives the seats their names
  const chat = await import("./hubChats");
  const conductor = await import("./roomConductor");
  const c = chat.createChat("hub", "Leadership team", members);
  const said = (convId: string) => chat.getChat(c.id)!.conversations.find((x) => x.id === convId)!.messages;
  return { chat, conductor, id: c.id, said };
}

type Reply = string | ((request: RoomTurnRequest, n: number) => string | Promise<string> | RoomTurnOutcome | Promise<RoomTurnOutcome>);

/**
 * A runner that answers from a script per Mono (each Mono's nth turn can differ) and records every call. Its Stop ends
 * the running turn the way the app's does (the turn settles as cancelled), unless `lateStops` keeps it going.
 */
function scripted(replies: Record<string, Reply>, { lateStops = false } = {}) {
  const calls: RoomTurnRequest[] = [];
  const stops: string[] = [];
  const cancel = new Map<string, () => void>();
  const count = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const run = vi.fn(async (request: RoomTurnRequest): Promise<RoomTurnOutcome> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(request);
    const n = (count.get(request.monoId) ?? 0) + 1;
    count.set(request.monoId, n);
    const stopped = new Promise<never>((_, reject) => cancel.set(request.monoId, () => reject(new Error("The turn was stopped."))));
    stopped.catch(() => undefined);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const reply = replies[request.monoId] ?? "NO_REPLY";
      const answer = Promise.resolve(typeof reply === "function" ? reply(request, n) : reply);
      const out = await (lateStops ? answer : Promise.race([answer, stopped]));
      return typeof out === "string" ? { kind: "reply", text: out } : out;
    } finally {
      cancel.delete(request.monoId);
      inFlight--;
    }
  });
  return {
    runner: {
      run,
      stop: vi.fn((mono: string) => {
        stops.push(mono);
        cancel.get(mono)?.();
      }),
    },
    calls,
    stops,
    who: () => calls.map((c) => c.monoId),
    maxInFlight: () => maxInFlight,
  };
}

const posts = (msgs: { from: string; kind?: string }[]) => msgs.filter((m) => m.from !== "ash" && m.from !== "app").map((m) => m.from);

it("the host answers Ash first, straight away, even for a message in another seat's lane; then each lane may add one reply", async () => {
  const { chat, id, said } = await room();
  const script = scripted({
    "chief-of-staff": "Heard: three cards left this week. PM, they're yours.",
    "projects-manager": "Login, export and billing copy. Billing copy waits on your price call.",
    frank: "NO_REPLY",
    alfred: "+1",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "what's left on the board for this week, and is anything stuck on me?");
  await chat.requestReply(id, conv);
  // No model is asked who answers: the host goes first.
  expect(script.who()[0]).toBe("chief-of-staff");
  expect(said(conv)[1]).toMatchObject({ from: "chief-of-staff", pick: { by: "lead" }, replyTo: said(conv)[0].id });
  expect(chat.roomPick(id)).toMatchObject({ id: "chief-of-staff", by: "lead" });
  // PM was named by the host ("PM, they're yours") and answers; nobody posts NO_REPLY or "+1".
  expect(posts(said(conv))).toEqual(["chief-of-staff", "projects-manager"]);
  expect(said(conv)[2]).toMatchObject({ quiet: true, pick: { by: "addressed" } });
  expect(script.calls.find((c) => c.monoId === "projects-manager")!.prompt).toContain("Chief of Staff addressed you in the message marked >>");
  expect(script.calls.find((c) => c.monoId === "projects-manager")!.prompt).toContain(">> Chief of Staff: Heard: three cards left");
});

it("a short message gets the host's answer and nobody else's; a bare acknowledgement becomes a 👍, never a bubble", async () => {
  const { chat, id, said } = await room();
  const router = vi.fn(async () => '{"chime":[{"id":"frank"},{"id":"projects-manager"}]}');
  chat.setRoomRouter(router);
  const script = scripted({ "chief-of-staff": "Waiting on Critiquito's pass, then the round goes to you." });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "wat now");
  await chat.requestReply(id, conv);
  expect(script.who()).toEqual(["chief-of-staff"]);
  expect(router).not.toHaveBeenCalled();
  // "thanks" to the host: it has nothing to add, and the room shows it read him.
  chat.setGroupChatRunner(scripted({ "chief-of-staff": "Got it." }).runner);
  chat.sendMessage(id, "thanks", conv);
  await chat.requestReply(id, conv);
  const last = said(conv).at(-1)!;
  expect(last).toMatchObject({ from: "ash", text: "thanks", reactions: { "👍": ["chief-of-staff"] } });
});

it("Ash's hello gets the host's hello and then each other seat's, once, with no router and no digest", async () => {
  const { chat, id, said } = await room();
  const router = vi.fn(async () => '{"chime":[]}');
  chat.setRoomRouter(router);
  const script = scripted({
    "chief-of-staff": "Morning. Nothing new on Tally from me overnight.",
    "projects-manager": "Morning. Board's at three cards, nothing blocked.",
    frank: "Morning, Ash.",
    alfred: "Morning. Team's as it was.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "yo morning");
  await chat.requestReply(id, conv);
  await vi.waitFor(() => expect(posts(said(conv))).toHaveLength(4));
  expect(posts(said(conv))[0]).toBe("chief-of-staff");
  expect(new Set(posts(said(conv)))).toEqual(new Set(TEAM));
  expect(router).not.toHaveBeenCalled();
  const hello = script.calls.find((c) => c.monoId === "frank")!.prompt;
  expect(hello).toContain("Ash just said hello to the room");
  expect(hello).not.toContain("You may add ONE short message");
  await new Promise((r) => setTimeout(r, 20));
  // Nobody closes a round of hellos with a digest.
  expect(script.who().filter((w) => w === "chief-of-staff")).toHaveLength(1);
  // An ask is not a hello: "hey can u check the board" stays the host's alone.
  const ask = chat.startConversation(id, "hey can u check the board");
  await chat.requestReply(id, ask);
  expect(posts(said(ask))).toEqual(["chief-of-staff"]);
});

it("a question to each of them gets each seat's own answer, the host's for itself only, and no digest", async () => {
  const { chat, id, said } = await room();
  const script = scripted({
    "chief-of-staff": "I set priority and hand work on.",
    "projects-manager": "I keep the board.",
    frank: "I check what we say against your words.",
    alfred: "I gate which Monos exist.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "who's on my team rn n what does each of u actually do");
  await chat.requestReply(id, conv);
  await vi.waitFor(() => expect(posts(said(conv))).toHaveLength(4));
  expect(script.calls[0].prompt).toContain("Answer for yourself only");
  expect(script.calls.find((c) => c.monoId === "alfred")!.prompt).toContain("Answer for yourself now");
  await new Promise((r) => setTimeout(r, 20));
  expect(script.who().filter((w) => w === "chief-of-staff")).toHaveLength(1);
});

it("@-mentioning a seat, or opening with its name, makes it answer first", async () => {
  const { chat, id, said } = await room();
  const script = scripted({ alfred: "Smallest structure: a skill on CoS, not a new Mono.", frank: "You said Fridays on 14 Oct." });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "@alfred should the board get a marketing Mono?");
  await chat.requestReply(id, conv);
  expect(script.who()[0]).toBe("alfred");
  expect(said(conv)[1].pick).toEqual({ by: "mention", why: "Ash @-mentioned Alfred" });
  chat.sendMessage(id, "frank, what did i say about release days", conv);
  await chat.requestReply(id, conv);
  expect(said(conv).at(-1)).toMatchObject({ from: "frank", pick: { by: "named" } });
});

it("the gate picks who may add one reply to Ash's message; those run side by side, each once", async () => {
  const { chat, id, said } = await room([...TEAM, "critiquito"]);
  chat.setRoomRouter(async () => '{"chime":[{"id":"frank","why":"two asks missing"},{"id":"critiquito","why":"the + menu look"},{"id":"chief-of-staff"}]}');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const script = scripted({
    "chief-of-staff": "Main beats: rename chats, a calm New conversation screen, a wider + menu. Tickets 8 to 15.",
    frank: async () => {
      await gate;
      return "Two asks are missing: connecting data inside the app, and a wider + menu (\"different variety of media\").";
    },
    critiquito: async () => {
      await gate;
      return "The + menu should copy Monocode: icon, white name, one grey line. Keep the icons grey.";
    },
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "I like the vision. New conversation should open a screen, the + should take more kinds of media, and I want to connect my own data from inside the app.");
  const done = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(chat.roomWorking(id).map((w) => w.monoId).sort()).toEqual(["critiquito", "frank"]));
  expect(chat.roomWorking(id).every((w) => w.state === "writing")).toBe(true);
  release();
  await done;
  expect(script.maxInFlight()).toBe(2);
  expect(posts(said(conv)).slice(0, 3)).toEqual(["chief-of-staff", "frank", "critiquito"]);
  expect(said(conv)[2]).toMatchObject({ quiet: true, pick: { by: "chime", why: "two asks missing" } });
  expect(script.calls.find((c) => c.monoId === "frank")!.prompt).toContain("Chief of Staff answered Ash. You may add ONE short message");
  // Three seats spoke: the host closes the stretch with a digest.
  expect(script.calls.at(-1)).toMatchObject({ monoId: "chief-of-staff" });
  expect(script.calls.at(-1)!.prompt).toContain("3 seats have spoken since Ash's last message");
});

it("the Monos keep a review loop going among themselves until nobody is named, well past the old 8-turn cap", async () => {
  const { chat, id, said } = await room([...TEAM, "critiquito"]);
  const script = scripted({
    "chief-of-staff": (_r, n) => (n === 1 ? "PM, build the round. frank and Critiquito review it." : n === 2 ? "Locked. Round 3 goes to Ash." : "NO_REPLY"),
    "projects-manager": (_r, n) =>
      [
        "Round 3 is ready: 9 screens, commit 06142365, 5506 tests pass. Still faked: the page builder. frank, Critiquito, please pass or flag.",
        "Fair on both. 06 gets plain role names, 07 gets Example labels. Retake is commit a2b82f27. frank and Critiquito, please re-check.",
        "Will do: 10 gets the Level 2 preview with Apply or Discard (commit b51c78dc). frank, please check.",
      ][n - 1] ?? "NO_REPLY",
    frank: (_r, n) =>
      [
        "PM, 06 doesn't do what Ash asked: he said \"better names in terms of what the actual role is\".",
        "06 passes. PM, 10 breaks a locked limit: a sidebar change is a Level 2 hub change.",
        "10 passes from me.",
      ][n - 1] ?? "NO_REPLY",
    critiquito: (_r, n) => (n === 1 ? "PM, 07 uses made-up data with no Example label." : n === 2 ? "07 passes from me. Nothing else until the next round." : "NO_REPLY"),
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "ok make the next round");
  await chat.requestReply(id, conv);
  const speakers = posts(said(conv));
  expect(speakers.length).toBeGreaterThan(8);
  expect(speakers).toEqual([
    "chief-of-staff",
    "projects-manager",
    "frank",
    "critiquito",
    "projects-manager",
    "frank",
    "critiquito",
    "projects-manager",
    "frank",
    "chief-of-staff",
  ]);
  // Both flags reached PM before it answered (one message for both, after the whole round), and the host locked it.
  const pmCalls = script.calls.filter((c) => c.monoId === "projects-manager");
  expect(pmCalls).toHaveLength(3);
  expect(pmCalls[1].prompt).toContain("06 doesn't do what Ash asked");
  expect(pmCalls[1].prompt).toContain("07 uses made-up data");
  expect(said(conv).at(-1)).toMatchObject({ from: "chief-of-staff", text: "Locked. Round 3 goes to Ash.", pick: { by: "digest" } });
  expect(chat.roomPaused(id, conv)).toBe(false);
  expect(chat.roomActive(id)).toBe(false);
});

it("two seats going back and forth without new ground pause the room for Ash; keep going carries on", async () => {
  const { chat, id, said } = await room();
  const fresh = ["amber", "violet", "glass", "dusk", "graphite", "contrast", "tokens", "status", "accent", "scheme", "hover", "border", "shadow", "label", "badge", "chip", "tile", "strip", "rail", "card", "sheet", "panel", "toast", "modal", "drawer", "slider", "toggle"];
  let n = 0;
  const words = () => `${fresh[n++ % fresh.length]} ${fresh[n++ % fresh.length]} ${fresh[n++ % fresh.length]}`;
  const script = scripted({
    "chief-of-staff": "frank, check the colour rule against Ash's words.",
    frank: () => `PM, colour stays for status only: ${words()}.`,
    "projects-manager": () => `frank, I read it differently, themes are open: ${words()}.`,
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "colour?");
  await chat.requestReply(id, conv);
  expect(chat.roomPaused(id, conv)).toBe(true);
  expect(chat.roomPauseReason(id, conv)).toBe("stalled");
  const note = said(conv).at(-1)!;
  expect(note).toMatchObject({ from: "app", kind: "system" });
  expect(note.text).toMatch(/back and forth/);
  const before = script.calls.length;
  // While paused, nobody posts.
  expect(() => chat.postFromMono(id, "frank", "One more thing.")).toThrow(/paused/);
  // Keep going: the seat that was named last runs, with fresh guards.
  chat.setGroupChatRunner(scripted({ frank: "That's Ash's call. Putting it to him with the screens." }).runner);
  chat.keepGoing(id, conv);
  await chat.roomIdle(id, conv);
  expect(said(conv).at(-2)).toMatchObject({ from: "app", text: "Ash asked the team to keep going." });
  expect(said(conv).at(-1)).toMatchObject({ from: "frank", text: "That's Ash's call. Putting it to him with the screens." });
  expect(script.calls.length).toBe(before);
  expect(chat.roomPaused(id, conv)).toBe(false);
});

it("posts that say nothing new pause the room; so does the ceiling of 40 posts without Ash", async () => {
  const { chat, id, said } = await room(["chief-of-staff", "projects-manager", "frank"]);
  chat.setGroupChatRunner(
    scripted({
      "chief-of-staff": "PM, frank: the board moves to Fridays.",
      "projects-manager": "frank, the board moves to Fridays, noted.",
      frank: "PM, the board moves to Fridays, noted.",
    }).runner,
  );
  const conv = chat.startConversation(id, "board to fridays");
  await chat.requestReply(id, conv);
  expect(chat.roomPauseReason(id, conv)).toBe("stalled");
  // The pause note lands when the guard trips; a turn already running may still land after it.
  expect(said(conv).find((m) => m.kind === "system")!.text).toMatch(/said nothing new/);

  const { MONO_POSTS_CEILING } = await import("./roomTurns");
  const many = Array.from({ length: 6 }, (_, i) => `m${i}`);
  const big = chat.createChat("hub", "Big room", many);
  let k = 0;
  // Every post names the next seat and says something new: only the ceiling stops it.
  chat.setGroupChatRunner(async (mono) => `m${(Number(mono.slice(1)) + 1) % many.length}, step ${++k}: ${"abcdefghijklmnopqrstuvwxyz".slice(k % 20, (k % 20) + 6)} ${k * 7919}`);
  const loop = chat.startConversation(big.id, "@m0 go");
  await chat.requestReply(big.id, loop);
  const bigPosts = posts(chat.getChat(big.id)!.conversations[0].messages);
  expect(bigPosts).toHaveLength(MONO_POSTS_CEILING);
  expect(chat.roomPauseReason(big.id, loop)).toBe("ceiling");
  expect(chat.getChat(big.id)!.conversations[0].messages.at(-1)!.text).toBe(`The team has posted ${MONO_POSTS_CEILING} messages since you last wrote, so it paused here for you.`);
});

it("Ash's message turns the room at once: running turns are stopped, waiting ones dropped, and the host answers both messages", async () => {
  const { chat, id, said } = await room();
  let stall!: (text: string) => void;
  const script = scripted({
    "chief-of-staff": (_r, n) => (n === 1 ? "PM, fix the Add model form. frank and Critiquito review it." : "On it, Ash: no review round. PM, fix the form and ship it."),
    "projects-manager": (_r, n) => (n === 1 ? new Promise<string>((r) => (stall = r)) : "Shipping the form fix now, no review."),
  }, { lateStops: true });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "the add model form is stuck, no way back");
  const first = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(chat.roomWorking(id).map((w) => w.monoId)).toEqual(["projects-manager"]));
  chat.sendMessage(id, "skip review just ship the fix pls", conv);
  chat.sendMessage(id, "on my comp", conv);
  const second = chat.requestReply(id, conv);
  expect(script.stops).toEqual(["projects-manager"]);
  // The stopped turn finishes late: its words never land.
  stall("Starting the review round with frank and Critiquito.");
  await Promise.all([first, second]);
  expect(said(conv).some((m) => m.text.startsWith("Starting the review round"))).toBe(false);
  const hostSecond = script.calls.filter((c) => c.monoId === "chief-of-staff")[1];
  expect(hostSecond.prompt).toContain("Ash just wrote (2 messages; answer them together)");
  expect(hostSecond.prompt).toContain("Ash: skip review just ship the fix pls");
  expect(posts(said(conv))).toEqual(["chief-of-staff", "chief-of-staff", "projects-manager"]);
  expect(said(conv).at(-1)!.text).toBe("Shipping the form fix now, no review.");
});

it("Stop ends every room turn in the conversation and keeps the room quiet until Ash writes", async () => {
  const { chat, id, said } = await room();
  const script = scripted({
    "chief-of-staff": "PM and frank, go.",
    "projects-manager": () => new Promise<string>(() => undefined),
    frank: () => new Promise<string>(() => undefined),
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "go");
  void chat.requestReply(id, conv);
  await vi.waitFor(() => expect(chat.roomWorking(id)).toHaveLength(2));
  expect(chat.roomActive(id, conv)).toBe(true);
  chat.stopRoom(id, conv);
  expect(script.stops.sort()).toEqual(["frank", "projects-manager"]);
  expect(chat.roomPauseReason(id, conv)).toBe("stopped");
  expect(said(conv).at(-1)).toMatchObject({ from: "app", text: "You stopped the room. The team waits for you." });
  expect(() => chat.postFromMono(id, "alfred", "One gate: Ash okays new Monos.")).toThrow(/Ash stopped this conversation/);
  // Ash writes again: the room is his again.
  chat.setGroupChatRunner(scripted({ "chief-of-staff": "Back on it." }).runner);
  chat.sendMessage(id, "ok carry on", conv);
  await chat.requestReply(id, conv);
  expect(chat.roomPaused(id, conv)).toBe(false);
  expect(said(conv).at(-1)).toMatchObject({ from: "chief-of-staff", text: "Back on it." });
});

it("a Mono busy in its own chat still answers: the turn goes into its work and it posts with room_post", async () => {
  const { chat, id, said } = await room();
  let finish!: () => void;
  const script = scripted({
    "chief-of-staff": "frank, check this against Ash's words.",
    frank: () => ({ kind: "wake", delivery: "steered", done: new Promise((r) => (finish = () => r({ status: "done" }))) }),
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "is everything I said in the tickets?");
  const done = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(chat.roomWorking(id)).toEqual([{ monoId: "frank", convId: conv, kind: "reply", state: "steered" }]));
  const request = script.calls.find((c) => c.monoId === "frank")!;
  expect(request.wakePrompt).toContain(`answer in the room with room_post (room "${id}")`);
  expect(request.note).toMatchObject({ kind: "room", room: "Leadership team", roomId: id, line: "Answered Chief of Staff" });
  // From its own chat: the post answers the wake (it replies to the message that woke it) and the indicator goes.
  const out = chat.postFromMono(id, "frank", "Two asks are missing: in-app data and a wider + menu.");
  expect(out.posted).toMatchObject({ from: "frank", replyTo: said(conv)[1].id, pick: { by: "addressed" } });
  expect(chat.roomWorking(id)).toEqual([]);
  finish();
  await done;
  expect(posts(said(conv))).toEqual(["chief-of-staff", "frank"]);
});

it("Ash writing again to a host that is busy in its own chat sends a second wake at once, not after that work", async () => {
  const { chat, id, said } = await room();
  const script = scripted({
    "chief-of-staff": () => ({ kind: "wake", delivery: "steered", done: new Promise(() => undefined) }),
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "status?");
  void chat.requestReply(id, conv);
  await vi.waitFor(() => expect(script.calls).toHaveLength(1));
  chat.sendMessage(id, "and the label?", conv);
  void chat.requestReply(id, conv);
  await vi.waitFor(() => expect(script.calls).toHaveLength(2));
  expect(script.calls[1].wakePrompt).toContain("Ash: and the label?");
  // Its post now answers the newer wake: both of Ash's messages are taken up.
  chat.postFromMono(id, "chief-of-staff", "Status: round 1 passed; the label is in.");
  expect(said(conv).at(-1)).toMatchObject({ from: "chief-of-staff", pick: { by: "lead" }, replyTo: said(conv)[1].id });
  expect(chat.getChat(id)!.conversations[0].answeredThrough).toBe(said(conv)[1].id);
});

it("never silent: a failed turn leaves a notice naming the Mono, and Try again runs it once more", async () => {
  const { chat, id, said } = await room();
  chat.setGroupChatRunner(
    scripted({
      "chief-of-staff": "frank, log the Friday rule.",
      frank: () => {
        throw new Error("You've hit your usage limit. Resets at 4pm.");
      },
    }).runner,
  );
  const conv = chat.startConversation(id, "from now on we never ship on fridays");
  await chat.requestReply(id, conv);
  const notice = said(conv).at(-1)!;
  expect(notice).toMatchObject({ from: "app", kind: "notice", notice: { mono: "frank", retry: true } });
  expect(notice.text).toBe("frank couldn't answer: You've hit your usage limit. Resets at 4pm.");
  chat.setGroupChatRunner(scripted({ frank: "Logged: never ship on Fridays (Ash, today)." }).runner);
  await chat.retryNotice(id, notice.id);
  expect(said(conv).find((m) => m.id === notice.id)!.notice).toEqual({ mono: "frank", retry: false });
  expect(said(conv).at(-1)).toMatchObject({ from: "frank", text: "Logged: never ship on Fridays (Ash, today)." });

  // The host's own failure, in plain words, and Try again answers Ash.
  chat.setGroupChatRunner(async () => {
    throw new Error("Cannot read properties of null (reading 'startsWith')");
  });
  chat.sendMessage(id, "and what's next", conv);
  await chat.requestReply(id, conv);
  const hostNotice = said(conv).at(-1)!;
  expect(hostNotice.text).toBe(
    "Chief of Staff couldn't start its turn because something in this copy of the app failed. Your message is saved. The details are in Chief of Staff's own chat.",
  );
  chat.setGroupChatRunner(scripted({ "chief-of-staff": "Next: the Pages round." }).runner);
  await chat.retryNotice(id, hostNotice.id);
  expect(said(conv).at(-1)).toMatchObject({ from: "chief-of-staff", text: "Next: the Pages round.", replyTo: said(conv).find((m) => m.text === "and what's next")!.id });
});

it("a room with no Mono, or no session engine, says so instead of answering", async () => {
  const { chat, id } = await room([]);
  const conv = chat.startConversation(id, "hello?");
  await chat.requestReply(id, conv);
  expect(chat.replyProblem(id, conv)).toBe("Add a Mono to this chat before sending.");
  const other = chat.createChat("hub", "Two", ["frank"]);
  const c2 = chat.startConversation(other.id, "hello?");
  await chat.requestReply(other.id, c2);
  expect(chat.replyProblem(other.id, c2)).toBe("The Mono session engine isn't connected. Open this chat in the desktop app.");
});

it("room_post: a member only, not inside its own managed room turn, cleaned of em dashes, and rate-limited", async () => {
  const { chat, id, said } = await room();
  const conv = chat.startConversation(id, "status?");
  expect(() => chat.postFromMono(id, "critiquito", "hi")).toThrow(/not in Leadership team/);
  const out = chat.postFromMono(id, "projects-manager", "Projects Manager: The homepage cut is ready — nothing is pushed.", { conversation: conv, now: 1_000 });
  expect(out.posted!.text).toBe("The homepage cut is ready, nothing is pushed.");
  expect(out.posted!.pick).toEqual({ by: "post", why: "Projects Manager posted from its own chat" });
  const news = ["The section is hidden behind a switch.", "Menu and footer links are hidden too.", "Pricing flows straight into FAQ.", "Tests pass: 5534.", "Before and after shots are in hub-qa."];
  news.forEach((text, i) => chat.postFromMono(id, "projects-manager", text, { conversation: conv, now: 2_000 + i }));
  expect(() => chat.postFromMono(id, "projects-manager", "One more.", { conversation: conv, now: 3_000 })).toThrow(/at most 6 posts a minute/);
  expect(chat.postFromMono(id, "frank", "Got it.", { replyTo: said(conv)[1].id }).reacted).toBe("👍");
  // During its own managed room turn its reply is the post.
  let release!: (t: string) => void;
  chat.setGroupChatRunner(scripted({ "chief-of-staff": () => new Promise<string>((r) => (release = r)) }).runner);
  chat.sendMessage(id, "next?", conv);
  const pending = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(typeof release).toBe("function"));
  expect(() => chat.postFromMono(id, "chief-of-staff", "Next is Pages.")).toThrow(/your reply is posted for you/);
  release("Next is Pages.");
  await pending;
});

it("work delegated from the room comes back as 'X is back' from the Mono that started it", async () => {
  const { chat, conductor, id, said } = await room();
  const script = scripted({ "chief-of-staff": "Launch platform shortlist is back: stay on Base; Clanker v4 first. Full write-up in my chat. frank, check it against Ash's asks." });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "research launch platforms in parallel");
  expect(conductor.postBack({ chatId: id, convId: conv, monoId: "chief-of-staff", title: "Launch platform shortlist", answer: "Ash, the shortlist is in: Base, then Clanker v4." })).toBe(true);
  await chat.roomIdle(id, conv);
  const back = script.calls[0];
  expect(back.prompt).toContain('Work you delegated from this room has come back: "Launch platform shortlist"');
  expect(back.prompt).toContain("Ash, the shortlist is in");
  expect(said(conv).find((m) => m.from === "chief-of-staff")).toMatchObject({ pick: { by: "back" } });
  expect(script.who()).toEqual(["chief-of-staff", "frank"]);
  expect(conductor.postBack({ chatId: id, convId: conv, monoId: "critiquito", title: "x", answer: "" })).toBe(false);
});

it("each project's Leadership team seats the default team once; a Mono Ash takes out stays out", async () => {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("./hubChats");
  const existing = chat.ensureLeadership("hivra");
  chat.addMember(existing.id, "hivra-lead");
  expect(chat.seatDefaultTeam("hivra").memberIds).toEqual([...TEAM, "hivra-lead"]);
  chat.removeMember(existing.id, "frank");
  expect(chat.seatDefaultTeam("hivra").memberIds).toEqual(["chief-of-staff", "projects-manager", "alfred", "hivra-lead"]);
  expect(chat.seatDefaultTeam("nibbii").memberIds).toEqual(TEAM);
});

it("the gate that doesn't answer in time, fails or answers nonsense never drops a seat: the lane rules pick, and say so", async () => {
  const { chat, id, said } = await room();
  const dump = "remember we agreed the board moves to Fridays; put the new cards on the board and keep my words for the delete rule";
  for (const router of [
    () => new Promise<string>(() => undefined), // never answers
    async () => {
      throw new Error("No engine for the room's router");
    },
    async () => "sure, frank should speak",
  ]) {
    chat.setRoomRouter(router, { timeoutMs: 30 });
    const script = scripted({ "chief-of-staff": "Heard: Fridays, new cards, the delete rule. PM has the board." , "projects-manager": "Cards 4 to 6 are up.", frank: "Saved: the board moves to Fridays." });
    chat.setGroupChatRunner(script.runner);
    const conv = chat.startConversation(id, dump);
    await chat.requestReply(id, conv);
    // PM (the board) and frank (memory) by their lanes, each once, labelled as the lanes' pick.
    expect(script.who().slice(0, 3)).toEqual(["chief-of-staff", "projects-manager", "frank"]);
    const pm = said(conv).find((m) => m.from === "projects-manager")!;
    expect(pm.pick).toMatchObject({ by: "lanes" });
    expect(pm.pick!.why).toMatch(/lane/);
  }
});

it("work that came back, with the gate down, still gets its check: frank looks at it, never nobody", async () => {
  const { chat, conductor, id, said } = await room();
  chat.setRoomRouter(() => new Promise<string>(() => undefined), { timeoutMs: 30 });
  const script = scripted({
    "chief-of-staff": "Delete is back: DELETE /tallies/:id works end to end (commit 3f2a1b0, 12/12 tests). Full report in my chat.",
    frank: "Checked against Ash's words: he asked for it to go for good, and it does. Pass from me.",
  });
  chat.setGroupChatRunner(script.runner);
  const conv = chat.startConversation(id, "add delete");
  conductor.postBack({ chatId: id, convId: conv, monoId: "chief-of-staff", title: "Delete", answer: "Delete is in." });
  await chat.roomIdle(id, conv);
  expect(script.who()).toEqual(["chief-of-staff", "frank"]);
  expect(said(conv).find((m) => m.from === "frank")!.pick).toMatchObject({ by: "lanes" });
});

it("the host's answer shows in the room as it is written, then becomes the message in the same place", async () => {
  const { chat, id, said } = await room();
  let write!: (text: string) => void;
  let end!: (text: string) => void;
  chat.setGroupChatRunner({
    run: (request) => {
      write = (text) => request.onText?.(text);
      return new Promise((resolve) => (end = (text) => resolve({ kind: "reply", text })));
    },
  });
  const conv = chat.startConversation(id, "wat now");
  const done = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(write).toBeTypeOf("function"));
  // Too little to tell from an acknowledgement or NO_REPLY: nothing shows yet, the seat is "writing".
  write("Heard");
  expect(chat.roomDrafts(id, conv)).toEqual([]);
  write("Heard you. Waiting on");
  expect(chat.roomDrafts(id, conv)).toMatchObject([{ monoId: "chief-of-staff", text: "Heard you. Waiting on", replyTo: said(conv)[0].id }]);
  const draftId = chat.roomDrafts(id, conv)[0].id;
  write("Chief of Staff: Heard you. Waiting on the Tally lead — its start-ack.");
  // Its own name label and em dashes are taken out as it streams, like the post.
  expect(chat.roomDrafts(id, conv)[0].text).toBe("Heard you. Waiting on the Tally lead, its start-ack.");
  // Nothing is saved while it is a draft.
  expect(said(conv)).toHaveLength(1);
  end("Heard you. Waiting on the Tally lead's start-ack. Nothing needs you.");
  await done;
  expect(chat.roomDrafts(id, conv)).toEqual([]);
  expect(said(conv)[1]).toMatchObject({ id: draftId, from: "chief-of-staff", text: "Heard you. Waiting on the Tally lead's start-ack. Nothing needs you." });
});

it("NO_REPLY, a reaction and a bare acknowledgement never show as they stream; a turn Ash overtakes loses its draft at once", async () => {
  const { chat, id, said } = await room();
  const writers: ((text: string) => void)[] = [];
  chat.setGroupChatRunner({
    run: (request) => {
      writers.push((text) => request.onText?.(text));
      return new Promise(() => undefined);
    },
    stop: () => undefined,
  });
  const conv = chat.startConversation(id, "wat now");
  void chat.requestReply(id, conv);
  await vi.waitFor(() => expect(writers).toHaveLength(1));
  for (const partial of ["NO_", "NO_REPLY", "<reac", "<reaction>👍</reaction>", "Got it, thanks!", "Checking the board now."]) {
    writers[0](partial);
    expect(chat.roomDrafts(id, conv), partial).toEqual([]);
  }
  writers[0]("The board has three cards left, all with the Tally lead.");
  expect(chat.roomDrafts(id, conv)).toHaveLength(1);
  // Ash writes again: the old turn is stopped and its words go at once; its late text never shows.
  chat.sendMessage(id, "and what about delete?", conv);
  void chat.requestReply(id, conv);
  expect(chat.roomDrafts(id, conv)).toEqual([]);
  writers[0]("The board has three cards left, all with the Tally lead, and more.");
  expect(chat.roomDrafts(id, conv).filter((d) => d.text.includes("more"))).toEqual([]);
  expect(said(conv).filter((m) => m.from !== "ash")).toEqual([]);
});
