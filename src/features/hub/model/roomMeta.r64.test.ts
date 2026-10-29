// @vitest-environment happy-dom
// r64 (realconv S8, 29 Oct): on "wat now" three seats gave three statuses, then Alfred and frank posted "I'll check ...
// before I add anything" / "Checked: nothing to add". Only the host gives the status; notes about a seat's own process
// never reach the room (logged, not shown); a near-copy of another Mono's post still never lands (r63).
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnRequest } from "./roomConductor";
import { isMetaSentence, isSecondStatus, isStatusAsk, stripMeta } from "./roomMeta";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

it("status asks in Ash's words are recognised; other asks are not", () => {
  for (const ask of [
    "wat now",
    "what now?",
    "where are we",
    "where we at",
    "fair but u all said different stuff. one of u tell me whats actually landed, whats still broken, n the one thing u need from me",
    "mind letting me know wat youve been up to bro n wats left?",
    "catch me up",
    "status?",
  ])
    expect(isStatusAsk(ask), ask).toBe(true);
  for (const ask of ["hey team", "fix the status bar colour", "what now looks wrong on the board is the font", "ship it", "who owns billing?"])
    expect(isStatusAsk(ask), ask).toBe(false);
});

it("S8's process notes are meta; facts, decisions and questions are not", () => {
  for (const s of [
    "I'll check the board before I add anything.",
    "CoS already set the order.",
    "I'll check the board and the worktree rule before I add anything.",
    "I'll look at the board once before I say anything.",
    "Agreed with CoS.",
    "Ash locked the order and CoS already answered.",
    "I'll only speak if the handoff to the lead isn't actually there.",
    "Checked: nothing to add to what's been said.",
    "Nothing new from me.",
    "Let me check the repo first.",
  ])
    expect(isMetaSentence(s), s).toBe(true);
  for (const s of [
    "The board is red: one stats test fails.",
    "One gate: the stats fix is the Tally lead's, and it lands in a worktree off main, not on main.",
    "I'll hand the stats fix to the Tally lead now.",
    "Should I check the billing card too?",
    "The fix already landed in main.",
  ])
    expect(isMetaSentence(s), s).toBe(false);
});

it("stripMeta keeps the facts and the layout, and reports what it dropped", () => {
  const alfred = "Agreed with CoS. One gate: the stats fix is the Tally lead's, and it lands in a worktree off main.";
  expect(stripMeta(alfred)).toEqual({
    text: "One gate: the stats fix is the Tally lead's, and it lands in a worktree off main.",
    dropped: ["Agreed with CoS."],
  });
  const pm = "I'll check the board before I add anything.\n\nNothing is assigned, and the Tally lead is free.";
  expect(stripMeta(pm).text).toBe("Nothing is assigned, and the Tally lead is free.");
  const frank = "I'll check CoS's landed-versus-broken list against the repo before I add anything.\n\nChecked: nothing to add to what's been said.";
  expect(stripMeta(frank).text).toBe("");
  const code = "```\nI'll check the board before I add anything.\n```";
  expect(stripMeta(code)).toEqual({ text: code, dropped: [] });
  expect(stripMeta("- Landed: create and list.\n- Agreed with CoS.").text).toBe("- Landed: create and list.");
});

it("a second status from another seat is told apart from one missed fact", () => {
  expect(isSecondStatus("**Landed.** Create, bump and list.\n**Not fixed.** The median.")).toBe(true);
  expect(isSecondStatus("Still open behind that, in backlog order: ".padEnd(400, "x"))).toBe(true);
  expect(isSecondStatus("One gate: the stats fix lands in a worktree off main, not on main.")).toBe(false);
});

const HOST =
  "Landed: create, bump and list. Not fixed: one stats test (even-count median). Waiting on you: nothing; I recommend the stats fix first.";

async function leadership(replies: Record<string, string>) {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("./hubChats");
  const meta = await import("./roomMeta");
  const c = chat.createChat("hub", "Leadership team", ["chief-of-staff", "projects-manager", "alfred", "frank"]);
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

it("on 'wat now' only the host gives the status; a second status and process notes stay out, one missed fact lands", async () => {
  const { ask, prompts, shown, log } = await leadership({
    "chief-of-staff": HOST,
    "projects-manager":
      "I'll check the board before I add anything.\n\nNothing is assigned, and the Tally lead is free, so the stats fix can start the moment you say go. Still open behind that, in backlog order: delete a tally (the board drops it), the weekly reset with last week's total, a streak badge, the UI types that drifted off packages/shared, and a GET /health check. Sharing stays parked.",
    alfred: "CoS already set the order. One gate: the stats fix lands in a worktree off main, not on main.",
    frank: "I'll check CoS's landed-versus-broken list against the repo before I add anything.\n\nChecked: nothing to add to what's been said.",
  });
  const posted = await ask("wat now");
  expect(posted.map((m) => m.from)).toEqual(["chief-of-staff", "alfred"]);
  expect(posted[1].text).toBe("One gate: the stats fix lands in a worktree off main, not on main.");
  expect(posted.some((m) => /before I add anything|nothing to add|already set/i.test(m.text))).toBe(false);
  // Logged for debugging, never shown.
  expect(log().map((e) => [e.monoId, e.why])).toEqual(
    expect.arrayContaining([
      ["projects-manager", "second-status"],
      ["frank", "meta"],
      ["alfred", "meta"],
    ]),
  );
  // Nothing from the other seats streamed in while they wrote.
  expect(shown.filter((s) => !s.startsWith("chief-of-staff:"))).toEqual([]);
  const host = prompts.find((p) => p.monoId === "chief-of-staff")!.prompt;
  expect(host).toContain("asking where things stand");
  expect(host).toContain("Landed / Not fixed / Waiting on you");
  const chime = prompts.find((p) => p.monoId === "frank")!.prompt;
  expect(chime).toContain("silence is right here: your reply is exactly NO_REPLY");
  expect(chime).not.toContain("he expects to hear from you too");
});

it("a hello to the room still gets every seat's own reply, minus the process notes", async () => {
  const { ask, prompts } = await leadership({
    "chief-of-staff": "Morning. The Pages round is next.",
    "projects-manager": "Let me check the board first. Three cards are open, all with the Tally lead.",
    frank: "Nothing new from me.",
  });
  const posted = await ask("hey team");
  expect(posted.map((m) => [m.from, m.text])).toEqual([
    ["chief-of-staff", "Morning. The Pages round is next."],
    ["projects-manager", "Three cards are open, all with the Tally lead."],
  ]);
  expect(prompts.find((p) => p.monoId === "frank")!.prompt).toContain("he expects to hear from you too");
});

it("the 75% near-copy block still holds after the process note is dropped", async () => {
  const { ask } = await leadership({
    "chief-of-staff": HOST,
    alfred: "Agreed with CoS. Landed: create, bump and list; not fixed: one stats test, the even-count median; nothing waits on you, stats fix first.",
  });
  const posted = await ask("hey, anything for me?");
  expect(posted.map((m) => m.from)).toEqual(["chief-of-staff"]);
});
