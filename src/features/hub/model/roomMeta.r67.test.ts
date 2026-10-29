// @vitest-environment happy-dom
// r67 (realconv S8 on 0.16.8, run b158): on "wat now" Projects Manager's room turn wrote "I'll check the board against
// that status before I stay quiet." and then ran tools before its NO_REPLY. On a status ask a seat that isn't the host
// posts nothing at all: its prompt says reply NO_REPLY with nothing before it and no tools, and as a backstop a post
// that is only acknowledgements or intentions is dropped whole (logged as "status-ack", never shown).
import { beforeEach, expect, it, vi } from "vitest";
import type { RoomTurnRequest } from "./roomConductor";
import { isAckOrIntentOnly } from "./roomMeta";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

it("ack or intent only: S8's line and its cousins; a fact, a question or a decision is not", () => {
  for (const t of [
    "I'll check the board against that status before I stay quiet.",
    "Checking the board first.",
    "Got it.",
    "On it. Let me look at the repo.",
    "Agreed with CoS.\n\nI'll verify the numbers against the board.",
    "One sec.",
  ])
    expect(isAckOrIntentOnly(t), t).toBe(true);
  for (const t of [
    "The median fix isn't on main yet: it's on its own branch.",
    "Checking the board: the streak card is still with the Tally lead.",
    "Should I hold the delete track?",
    "I'll hand the stats fix to the Tally lead now. It's the one red test.",
    "",
  ])
    expect(isAckOrIntentOnly(t), t).toBe(false);
});

const HOST = "Landed: create, bump and list. Not fixed: the even-day median. Waiting on you: nothing; I recommend the median first.";

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

it("on 'wat now' a non-host seat's prompt asks for NO_REPLY with nothing before it and no tools", async () => {
  const { ask, prompts } = await leadership({ "chief-of-staff": HOST });
  await ask("wat now");
  const chime = prompts.find((p) => p.monoId === "projects-manager")!.prompt;
  expect(chime).toContain("your reply is exactly NO_REPLY, with nothing before it");
  expect(chime).toContain("Don't open the board, run a tool or check anything for this turn");
  expect(chime).toContain("write no line about what you're doing or why you're staying quiet");
  // The host still reads the board and gives the one status.
  expect(prompts.find((p) => p.monoId === "chief-of-staff")!.prompt).toContain("read task_status and the board first");
});

it("on 'wat now' ack and intent posts from other seats are dropped whole; a missed fact still lands", async () => {
  const { ask, shown, log } = await leadership({
    "chief-of-staff": HOST,
    "projects-manager": "I'll check the board against that status before I stay quiet.",
    frank: "Checking the board first.",
    alfred: "Got it. The median fix lands in a worktree off main, not on main.",
  });
  const posted = await ask("wat now");
  expect(posted.map((m) => [m.from, m.text])).toEqual([
    ["chief-of-staff", HOST],
    ["alfred", "The median fix lands in a worktree off main, not on main."],
  ]);
  expect(log().filter((e) => e.why === "status-ack").map((e) => e.monoId)).toEqual(["frank"]);
  expect(shown.filter((s) => !s.startsWith("chief-of-staff:"))).toEqual([]);
});

it("outside a status ask the same intent line doesn't silence a seat with a fact", async () => {
  const { ask } = await leadership({
    "chief-of-staff": "Morning. The Pages round is next.",
    frank: "Checking the board first. Three cards are open, all with the Tally lead.",
  });
  const posted = await ask("hey team");
  expect(posted.map((m) => m.from)).toEqual(["chief-of-staff", "frank"]);
  expect(posted[1].text).toContain("Three cards are open");
});
