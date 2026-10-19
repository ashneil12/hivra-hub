// @vitest-environment happy-dom
// The room taking turns, end to end through hubChats with a stand-in runner (each Mono's session) and router (the
// small model): one answerer, at most one new reply from each other member, NO_REPLY never posted, a Mono addressed
// by name answers once, the 8-turn cap, one turn in flight per room, and what Ash sends mid-turn batched.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const TEAM = ["chief-of-staff", "projects-manager", "frank", "alfred"];

async function room(members: string[] = TEAM) {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos(); // the roster gives the seats their names
  const chat = await import("./hubChats");
  const c = chat.createChat("hub", "Leadership team", members);
  const said = (convId: string) => chat.getChat(c.id)!.conversations.find((x) => x.id === convId)!.messages;
  return { chat, id: c.id, said };
}

/** A runner that answers from a script per Mono and records every call; it also checks one turn at a time. */
function scripted(replies: Record<string, string | ((prompt: string) => string)>) {
  const calls: { mono: string; prompt: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = vi.fn(async (mono: string, prompt: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ mono, prompt });
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const reply = replies[mono] ?? "NO_REPLY";
    return typeof reply === "function" ? reply(prompt) : reply;
  });
  return { run, calls, maxInFlight: () => maxInFlight };
}

it("without a router, the lane rules pick the answerer and who may add something; NO_REPLY and '+1' are never posted", async () => {
  const { chat, id, said } = await room();
  const runner = scripted({
    "projects-manager": "Three cards left this week: login, export, billing copy.",
    "chief-of-staff": "One add: billing copy waits on your price call.",
    frank: "NO_REPLY",
    alfred: "+1",
  });
  chat.setGroupChatRunner(runner.run);
  const conv = chat.startConversation(id, "what's left on the board for this week?");
  await chat.requestReply(id, conv);
  // board/what's left beats "this week": Projects Manager answers; Chief of Staff's lane ("this week") lets it chime
  expect(runner.calls.map((c) => c.mono)).toEqual(["projects-manager", "chief-of-staff"]);
  const msgs = said(conv);
  expect(msgs.map((m) => [m.from, m.quiet ?? false])).toEqual([["ash", false], ["projects-manager", false], ["chief-of-staff", true]]);
  expect(msgs[1].pick).toEqual({ by: "lanes", why: "squarely Projects Manager's lane" });
  expect(msgs[2].pick?.by).toBe("chime");
  expect(runner.calls[1].prompt).toContain("Projects Manager answered. You may add ONE short reply");
  expect(runner.calls[1].prompt).toContain("Projects Manager: Three cards left");
  expect(chat.roomPick(id)).toMatchObject({ id: "projects-manager" });
  expect(runner.maxInFlight()).toBe(1);
});

it("an @mention wins over the lanes and the router", async () => {
  const { chat, id, said } = await room();
  const router = vi.fn(async () => '{"answerer":"chief-of-staff"}');
  chat.setRoomRouter(router);
  const runner = scripted({ alfred: "Smallest structure: a skill on CoS, not a new Mono." });
  chat.setGroupChatRunner(runner.run);
  const conv = chat.startConversation(id, "@alfred should the board get a marketing Mono?");
  await chat.requestReply(id, conv);
  expect(runner.calls[0].mono).toBe("alfred");
  expect(said(conv)[1].pick).toEqual({ by: "mention", why: "Ash @-mentioned Alfred" });
  // the router was asked only who else may add something, never who answers
  expect(router.mock.calls.every(([p]) => !String(p).includes('"answerer"'))).toBe(true);
});

it("with no rule matching, the cheap router picks the answerer and gates the chime-ins", async () => {
  const { chat, id, said } = await room();
  const router = vi.fn(async (prompt: string) =>
    prompt.includes('"answerer"') ? 'ok {"answerer":"frank","why":"a question about what Ash decided"}' : '{"chime":[{"id":"alfred","why":"a gate on who decides"}]}',
  );
  chat.setRoomRouter(router);
  const runner = scripted({ frank: "You locked colour-for-status on 14 Oct.", alfred: "One gate: theme colour stays Ash's call." });
  chat.setGroupChatRunner(runner.run);
  const conv = chat.startConversation(id, "did we ever settle the colour thing");
  await chat.requestReply(id, conv);
  expect(runner.calls.map((c) => c.mono)).toEqual(["frank", "alfred"]);
  expect(said(conv)[1].pick).toEqual({ by: "router", why: "a question about what Ash decided" });
  expect(said(conv)[2]).toMatchObject({ from: "alfred", quiet: true, pick: { by: "chime", why: "a gate on who decides" } });
  const pickPrompt = String(router.mock.calls[0][0]);
  expect(pickPrompt).toContain("- frank: frank (memory and checks)");
  expect(pickPrompt).toContain("Ash: did we ever settle the colour thing");
});

it("a router that answers nonsense (or fails) falls back to the lane rules, after one retry", async () => {
  const { chat, id, said } = await room();
  const router = vi.fn(async () => "I think frank, probably");
  chat.setRoomRouter(router);
  const runner = scripted({ "chief-of-staff": "Main beats: launch Friday, price call is yours." });
  chat.setGroupChatRunner(runner.run);
  const conv = chat.startConversation(id, "morning, big day");
  await chat.requestReply(id, conv);
  expect(router.mock.calls.filter(([p]) => String(p).includes('"answerer"'))).toHaveLength(2);
  expect(String(router.mock.calls[1][0])).toContain("Name exactly one member id");
  expect(said(conv)[1]).toMatchObject({ from: "chief-of-staff", pick: { by: "lanes" } });
  chat.setRoomRouter(async () => { throw new Error("not logged in"); });
  const again = chat.startConversation(id, "and tomorrow?");
  await chat.requestReply(id, again);
  expect(said(again)[1]).toMatchObject({ from: "chief-of-staff", pick: { by: "lanes" } });
});

it("a Mono another Mono addresses answers once; each speaks at most once more; the room stops at 8 turns and waits for Ash", async () => {
  const members = Array.from({ length: 10 }, (_, i) => `m${i}`);
  const { chat, id, said } = await room(members);
  // every reply addresses everyone, which would loop forever without the rules
  const runner = scripted(Object.fromEntries(members.map((m) => [m, `${members.filter((x) => x !== m).map((x) => `@${x}`).join(" ")} thoughts?`])));
  chat.setGroupChatRunner(runner.run);
  const conv = chat.startConversation(id, "@m0 kick it off");
  await chat.requestReply(id, conv);
  expect(runner.calls).toHaveLength(8);
  const speakers = runner.calls.map((c) => c.mono);
  expect(speakers[0]).toBe("m0");
  expect(new Set(speakers.slice(1)).size).toBe(7); // each addressed Mono answered once
  expect(speakers.slice(1).includes("m0")).toBe(true); // the answerer may answer once when addressed
  expect(chat.roomPaused(id, conv)).toBe(true);
  expect(said(conv).filter((m) => m.from !== "ash")).toHaveLength(8);
  // Ash speaking again opens a new exchange
  chat.sendMessage(id, "@m1 wrap up", conv);
  runner.run.mockImplementation(async (mono: string) => (mono === "m1" ? "Wrapped." : "NO_REPLY"));
  await chat.requestReply(id, conv);
  expect(chat.roomPaused(id, conv)).toBe(false);
  expect(said(conv).at(-1)).toMatchObject({ from: "m1", text: "Wrapped." });
});

it("one turn in flight per room: what Ash sends mid-turn waits, cuts the exchange short and is answered together", async () => {
  const { chat, id, said } = await room();
  let release!: (text: string) => void;
  const prompts: { mono: string; prompt: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  chat.setGroupChatRunner(async (mono, prompt) => {
    prompts.push({ mono, prompt });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (prompts.length === 1) return await new Promise<string>((r) => { release = r; });
      return mono === "frank" ? "Logged both, and the Friday rule is saved." : "NO_REPLY";
    } finally {
      inFlight--;
    }
  });
  const conv = chat.startConversation(id, "remember the board moves to fridays");
  const first = chat.requestReply(id, conv);
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  expect(chat.typingIn(id)).toBe("chief-of-staff"); // two lanes in one message: Chief of Staff answers
  chat.sendMessage(id, "also the export ticket is done", conv);
  await chat.requestReply(id, conv); // returns at once: a turn is in flight
  chat.sendMessage(id, "@frank log both", conv);
  await chat.requestReply(id, conv);
  expect(prompts).toHaveLength(1);
  release("Heard: the board moves to Fridays; frank logs it.");
  await first;
  // the first exchange stopped after its answer (no chime-ins), then one exchange answered both new messages
  // (frank, @-mentioned; "ticket" gave Projects Manager a chance to add something, and it had nothing)
  expect(prompts.map((p) => p.mono)).toEqual(["chief-of-staff", "frank", "projects-manager"]);
  expect(prompts[1].prompt).toContain("he sent 2 messages while the room was busy");
  expect(prompts[1].prompt).toContain("Ash: also the export ticket is done");
  expect(maxInFlight).toBe(1);
  expect(said(conv).map((m) => m.from)).toEqual(["ash", "ash", "ash", "chief-of-staff", "frank"]);
  expect(said(conv).at(-1)?.pick).toEqual({ by: "mention", why: "Ash @-mentioned frank" });
});

it("a chime-in that can't run (the Mono is busy in its own chat) is skipped quietly; a failed answer is shown and can be retried", async () => {
  const { chat, id, said } = await room();
  chat.setGroupChatRunner(async (mono) => {
    if (mono === "frank") throw new chat.MonoBusyError("This Mono is already working.");
    if (mono === "chief-of-staff") return "Heard: rule saved, frank to log it.";
    return "NO_REPLY";
  });
  const conv = chat.startConversation(id, "from now on we never ship on fridays, remember it, and what's the priority today");
  await chat.requestReply(id, conv);
  expect(chat.replyProblem(id, conv)).toBeUndefined();
  expect(said(conv).map((m) => m.from)).toEqual(["ash", "chief-of-staff"]);

  chat.setGroupChatRunner(async () => { throw new chat.MonoBusyError("This Mono is already working. Wait for it to finish before trying again."); });
  const next = chat.startConversation(id, "@frank what did I just say");
  await chat.requestReply(id, next);
  expect(chat.replyProblem(id, next)).toContain("already working");
  expect(chat.roomPick(id)).toMatchObject({ id: "frank", by: "mention" });
  chat.setGroupChatRunner(async (mono) => (mono === "frank" ? "Never ship on Fridays." : "NO_REPLY"));
  await chat.retryReply(id);
  expect(chat.replyProblem(id, next)).toBeUndefined();
  expect(said(next).at(-1)).toMatchObject({ from: "frank", text: "Never ship on Fridays." });
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
