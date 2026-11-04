// @vitest-environment happy-dom
// r66: on "who does what?" the host described every seat and the others stayed silent; posts
// opened with narration ("Ash wants...", "I'll check...", S8 on 0.16.7: "Ada asked me to keep Ash's words. I'll save
// them as he said them."). Each seat now gives its own role; opening narration is dropped; a status ask is unchanged.
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnRequest } from "./roomConductor";
import { isNarrationSentence, isRolesAsk, isStatusAsk, stripLeadNarration, stripMeta, stripOtherSeats } from "./roomMeta";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

const HOST =
  "Landed: create, bump and list. Not fixed: one stats test (even-count median). Waiting on you: nothing; I recommend the stats fix first.";

async function leadership(replies: Record<string, string>) {
  const { addMono } = await import("../../monos/model/mono");
  for (const [id, name] of [
    ["ada", "Ada"],
    ["bo", "Bo"],
    ["ed", "Ed"],
    ["cam", "Cam"],
    ["dee", "Dee"],
  ] as const)
    addMono({ id, name, mascot: "robot", color: "gray", projects: [] });
  const chat = await import("./hubChats");
  const meta = await import("./roomMeta");
  const c = chat.createChat("hub", "Leadership team", ["ada", "bo", "cam", "ed"]);
  const prompts: RoomTurnRequest[] = [];
  const shown: string[] = [];
  chat.setGroupChatRunner({
    run: async (request: RoomTurnRequest) => {
      prompts.push(request);
      const text = replies[request.monoId] ?? "NO_REPLY";
      request.onText?.(text);
      shown.push(...chat.roomDrafts(c.id).map((d) => `${d.monoId}: ${d.text}`));
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "reply", text };
    },
    stop: () => undefined,
  });
  const ask = async (text: string) => {
    const conv = chat.startConversation(c.id, text);
    await chat.requestReply(c.id, conv);
    return chat.getChat(c.id)!.conversations.find((x) => x.id === conv)!.messages.filter((m) => m.from !== "ash" && m.from !== "app");
  };
  return { ask, prompts, shown, log: meta.roomDroppedLog };
}

it("roles asks are told apart from status asks", () => {
  for (const t of ["who does what?", "whos doing what", "what are your roles", "what do you each do", "introduce yourselves", "roles?", "who handles what here", "who is on what"])
    expect([t, isRolesAsk(t), isStatusAsk(t)]).toEqual([t, true, false]);
  for (const t of ["wat now", "where are we", "whats landed", "catch me up"]) expect([t, isRolesAsk(t)]).toEqual([t, false]);
  for (const t of ["who's next", "what's next", "hey team", "ship it"]) expect([t, isRolesAsk(t)]).toEqual([t, false]);
});

it("on 'who does what?' each seat gives its own role; the host's lines about the others are dropped", async () => {
  const { ask, prompts, log } = await leadership({
    "ada":
      "I'm Ada: I work out with you what matters now and hand project work to the right team.\n- Bo: keeps the board.\n- **Cam**: reviews every change. Ed keeps the memory.",
    "bo": "I keep the board: every card, who has it and what state it's in.",
    cam: "I review what lands and hold the gates: worktrees, tests, no direct pushes to main.",
    ed: "I keep the memory: your words as you said them, and the decisions behind them.",
  });
  const posted = await ask("who does what?");
  expect(posted[0].from).toBe("ada");
  const by = Object.fromEntries(posted.map((m) => [m.from, m.text]));
  expect(by).toEqual({
    "ada": "I'm Ada: I work out with you what matters now and hand project work to the right team.",
    "bo": "I keep the board: every card, who has it and what state it's in.",
    cam: "I review what lands and hold the gates: worktrees, tests, no direct pushes to main.",
    ed: "I keep the memory: your words as you said them, and the decisions behind them.",
  });
  expect(log().filter((e) => e.why === "other-seats").map((e) => e.monoId)).toEqual(["ada"]);
  const host = prompts.find((p) => p.monoId === "ada")!.prompt;
  expect(host).toContain("asking who does what");
  expect(host).toContain("Don't describe, list or speak for the other seats");
  expect(host).not.toContain("Landed / Not fixed / Waiting on you");
  const chime = prompts.find((p) => p.monoId === "ed")!.prompt;
  expect(chime).toContain("this is your turn to give yours");
  expect(chime).not.toContain("silence is right here");
});

it("a seat's own role is never dropped as a near-copy of another seat's on a roles ask", async () => {
  const { ask } = await leadership({
    "ada": "I keep the plan with you and hand the work out.",
    "bo": "I keep the board with you and hand the work out to leads.",
  });
  const posted = await ask("what are your roles");
  expect(posted.map((m) => m.from)).toEqual(["ada", "bo"]);
});

it("a status ask still gets one host answer", async () => {
  const { ask } = await leadership({
    "ada": HOST,
    "bo": "Landed: create and bump. Not fixed: the median test. Waiting on you: nothing.",
    cam: "NO_REPLY",
    ed: "Agreed with Ada.",
  });
  const posted = await ask("wat now");
  expect(posted.map((m) => m.from)).toEqual(["ada"]);
});

it("S8's opening narration is dropped, the facts after it are kept", () => {
  const cases: [string, string][] = [
    [
      "Sharing is settled and the order is set. I'll hand the build to the Tally lead and get the decision written down.\n\nLocked, Ash: stats fix first, then delete.",
      "Locked, Ash: stats fix first, then delete.",
    ],
    [
      "Ada locked the order and asked me to put it on the board. I'll find how this project's board is kept, then write the states.\n\nOn the board: stats fix in progress, delete next.",
      "On the board: stats fix in progress, delete next.",
    ],
    ["Ada asked me to keep Ash's words. I'll save them as he said them.\n\nKept, his words: ship stats first.", "Kept, his words: ship stats first."],
    ["Ash wants the order kept. Stats fix is first, then delete.", "Stats fix is first, then delete."],
    ["Let me pull it up. The board has three open cards.", "The board has three open cards."],
  ];
  for (const [post, want] of cases) expect(stripMeta(post).text).toBe(want);
});

it("narration is only stripped at the start, never leaves an empty post, and spares questions and lists", () => {
  expect(stripLeadNarration("Landed: create. I'll hand the rest to Bo.").dropped).toEqual([]);
  expect(stripLeadNarration("I'll hand the build to the Tally lead.").text).toBe("I'll hand the build to the Tally lead.");
  expect(stripLeadNarration("- I'll take the stats fix.\n- Bo has delete.").dropped).toEqual([]);
  expect(isNarrationSentence("Ash, want me to start the stats fix?")).toBe(false);
  expect(isNarrationSentence("The stats fix is merged.")).toBe(false);
  expect(isNarrationSentence("I'm going to hand it to the lead.")).toBe(true);
  expect(isNarrationSentence("Ash asked for the order.")).toBe(true);
});

it("stripOtherSeats keeps the seat's own words and anything not about another seat's role", () => {
  const out = stripOtherSeats("I'm Ed: I keep the memory. Bo's job is the board. Ask me for any decision.", ["Bo"]);
  expect(out.text).toBe("I'm Ed: I keep the memory. Ask me for any decision.");
  expect(stripOtherSeats("Bo, can you add the card?", ["Bo"]).dropped).toEqual([]);
});
