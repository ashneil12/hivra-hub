// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { WaitingChat } from "../../hub/model/waitingChats";
import type { Delegation } from "../../monos/model/delegations";
import type { UserQuestionPrompt } from "../../sessions/model/userQuestion";
import { fromPage, pageActionLog, resetPageActionsForTest, runPageAction, type PageActionDeps } from "./pageActions";

const ctx = { pageId: "pg_1", pageTitle: "Agents" };
const prompt: UserQuestionPrompt = { requestId: 9, questions: [{ id: "q", prompt: "Example: which slot?", multiSelect: false, allowCustom: true, options: [{ id: "a", label: "Slot 2 (Recommended)" }, { id: "b", label: "Slot 3" }] }] };
const row = (id: string, over: Partial<Delegation> = {}) => ({ id, ownerSession: "s-lead", childSession: `w-${id}`, state: "running", title: `Example: ${id}`, ...over }) as Delegation;

function deps(over: Partial<PageActionDeps> = {}) {
  const calls: unknown[][] = [];
  const note = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const waiting: WaitingChat[] = [
    { sessionId: "s-lead", source: "ask", requestId: 3, chatName: "EXO lead", question: "Example: which layout?", pick: "Three slots" } as WaitingChat,
    { sessionId: "s-hivra", source: "marker", chatName: "Hivra lead", question: "Example: send it today?", pick: "send it today" } as WaitingChat,
  ];
  const d: PageActionDeps = {
    host: () => ({
      liveQuestion: (id) => (id === "w-d2" ? prompt : undefined),
      respond: note("respond"),
      send: async (...a) => { calls.push(["send", ...a]); return true; },
      open: note("open"),
      openMono: note("openMono"),
    }),
    findWaiting: (id) => waiting.find((w) => w.sessionId === id),
    answerInWords: async (id, text) => { calls.push(["answerInWords", id, text]); return { ok: true, sent: text, chatName: "EXO lead" }; },
    takePick: async (id) => { calls.push(["takePick", id]); return { ok: true, sent: "Three slots", chatName: "EXO lead" }; },
    openWaiting: note("openWaiting"),
    answerNeed: note("answerNeed"),
    rows: () => [row("d1"), row("d2", { state: "question" }), row("d3", { state: "completed" })],
    delegationActions: () => ({
      openOwner: note("openOwner"),
      openChild: note("openChild"),
      stopTree: async (chat) => { calls.push(["stopTree", chat]); return { stopped: [chat], cancelled: [], stopFailed: [] }; },
      stopRow: async (r) => { calls.push(["stopRow", r.id]); return { stopped: [r.childSession], cancelled: [r.id], stopFailed: [] }; },
    }),
    findMono: (id) => (id === "ed" ? { id, name: "ed", sessionId: "s-ed", mascot: "letter", color: "", projects: [] } : id === "cam" ? { id, name: "Alfred", mascot: "letter", color: "", projects: [] } : undefined),
    monoForSession: (id) => (id === "s-lead" ? { id: "vg-game-lead", name: "EXO lead", sessionId: id, mascot: "letter", color: "", projects: [] } : undefined),
    ...over,
  };
  return { d, calls };
}

beforeEach(() => resetPageActionsForTest());

it("says which page sent it, in the words that reach the chat", () => {
  expect(fromPage("Agents")).toBe("(sent from the Agents page)");
  expect(fromPage("Release page")).toBe("(sent from the Release page)");
});

it("answers a waiting chat the way Waiting on you does, signed with the page", async () => {
  const { d, calls } = deps();
  const out = await runPageAction("agents.answer", { chatId: "s-lead", text: "Go with three" }, ctx, d);
  expect(calls).toEqual([["answerInWords", "s-lead", "Go with three\n\n(sent from the Agents page)"]]);
  expect(out).toEqual({ done: "Answered EXO lead" });
  expect(pageActionLog("pg_1").map((e) => e.line)).toEqual(["Answered EXO lead: “Go with three”"]);
});

it("answers a worker's live question in its own chat (Ash's in-chat answer), and takes its recommended pick", async () => {
  const { d, calls } = deps();
  await runPageAction("agents.answer", { chatId: "w-d2", text: "Slot 3 please" }, ctx, d);
  expect(calls[0][0]).toBe("respond");
  expect(calls[0].slice(1, 3)).toEqual(["w-d2", 9]);
  expect(JSON.stringify(calls[0][3])).toContain("Slot 3 please\\n\\n(sent from the Agents page)");
  await runPageAction("agents.pick", { chatId: "w-d2" }, ctx, d);
  expect(calls[1]).toEqual(["respond", "w-d2", 9, { kind: "answered", answers: { q: ["a"] } }]);
  await runPageAction("agents.pick", { chatId: "s-lead" }, ctx, d);
  expect(calls[2]).toEqual(["takePick", "s-lead"]);
  // A "Needs Ash:" line is answered with Waiting on you's own words for the pick, signed.
  await runPageAction("agents.pick", { chatId: "s-hivra" }, ctx, d);
  expect(calls[3]).toEqual(["answerInWords", "s-hivra", "Go with your pick: send it today\n\n(sent from the Agents page)"]);
});

it("an Ash OS question goes through Ash's own answer call", async () => {
  const { d, calls } = deps();
  await runPageAction("agents.answer", { needId: "q:7", text: "Headline B" }, ctx, d);
  await runPageAction("agents.pick", { needId: "q:7" }, ctx, d);
  expect(calls).toEqual([["answerNeed", "q:7", { text: "Headline B", from: "pg_1" }], ["answerNeed", "q:7", { quick: "agree", from: "pg_1" }]]);
});

it("messages a Mono in its own chat, and refuses one with no chat yet", async () => {
  const { d, calls } = deps();
  await runPageAction("agents.message", { agentId: "ed", text: "Check the pricing page" }, ctx, d);
  expect(calls).toEqual([["send", "s-ed", "Check the pricing page\n\n(sent from the Agents page)"]]);
  await expect(runPageAction("agents.message", { agentId: "cam", text: "hi" }, ctx, d)).rejects.toThrow("Alfred has no chat yet. Open it once first.");
  await expect(runPageAction("agents.message", { agentId: "ed", text: "  " }, ctx, d)).rejects.toThrow("Type a message first.");
});

it("stops handed-out work with the tree's own Stop, and a Mono's chat with Stop on that chat", async () => {
  const { d, calls } = deps();
  expect(await runPageAction("agents.stop", { workerId: "d1" }, ctx, d)).toEqual({ done: "Stopped “Example: d1”" });
  await runPageAction("agents.stop", { agentId: "ed" }, ctx, d);
  await expect(runPageAction("agents.stop", { workerId: "d3" }, ctx, d)).rejects.toThrow("That work already finished.");
  expect(calls).toEqual([["stopRow", "d1"], ["stopTree", "s-ed"]]);
  expect(pageActionLog("pg_1").map((e) => e.line)).toEqual(["Stopped ed", "Stopped “Example: d1”"]);
});

it("opens a worker under its Mono, a Mono, and a waiting chat, through the app's own Open", async () => {
  const { d, calls } = deps();
  await runPageAction("chats.open", { workerId: "d1" }, ctx, d);
  await runPageAction("chats.open", { agentId: "ed" }, ctx, d);
  await runPageAction("chats.open", { chatId: "s-lead" }, ctx, d);
  await runPageAction("chats.open", { chatId: "w-d2" }, ctx, d);
  expect(calls).toEqual([["openChild", "s-lead", "w-d1"], ["openMono", "ed"], ["openWaiting", "s-lead"], ["openChild", "s-lead", "w-d2"]]);
});

it("says plainly when the app can't do it yet, and never guesses", async () => {
  const { d } = deps({ host: () => undefined, delegationActions: () => undefined });
  await expect(runPageAction("agents.message", { agentId: "ed", text: "x" }, ctx, d)).rejects.toThrow("The app isn't ready for that yet. Open the chat instead.");
  await expect(runPageAction("agents.stop", { workerId: "d1" }, ctx, d)).rejects.toThrow("The app isn't ready to stop work yet.");
  await expect(runPageAction("agents.answer", { chatId: "nope", text: "x" }, ctx, d)).rejects.toThrow("That chat isn't asking anything now.");
  const failing = deps({ answerInWords: async () => ({ ok: false, reason: "EXO lead couldn't take a message right now. Open the chat to answer." }) });
  await expect(runPageAction("agents.answer", { chatId: "s-lead", text: "x" }, ctx, failing.d)).rejects.toThrow("EXO lead couldn't take a message right now.");
  vi.restoreAllMocks();
});

// C4 (Ash: "dashboards that are genuinely connected to agents ... so i can ... see what the agents are doing and
// respond"): mono.run and tasks.write no longer answer "Not connected yet"; each takes the tap's own path.
it("mono.run asks a Mono to run work, as a message from the page into its chat", async () => {
  const { d, calls } = deps();
  expect(await runPageAction("mono.run", { agentId: "ed", text: "Pull this week's signups" }, ctx, d)).toEqual({ done: "Asked ed to run" });
  expect(calls).toEqual([["send", "s-ed", "Pull this week's signups\n\n(sent from the Agents page)"]]);
  expect(pageActionLog("pg_1")[0].line).toBe("Asked ed to run: “Pull this week's signups”");
  await expect(runPageAction("mono.run", { text: "x" }, ctx, d)).rejects.toThrow("Say which Mono should run it (agentId).");
  await expect(runPageAction("mono.run", { agentId: "ed" }, ctx, d)).rejects.toThrow("Say what to run first.");
  await expect(runPageAction("mono.run", { agentId: "nobody", text: "x" }, ctx, d)).rejects.toThrow("That agent isn't on your Monos list.");
});

it("tasks.write answers, stops or hands out a task the way the taps do, and refuses anything else plainly", async () => {
  const { d, calls } = deps();
  expect(await runPageAction("tasks.write", { op: "answer", chatId: "s-lead", text: "Three" }, ctx, d)).toEqual({ done: "Answered EXO lead" });
  expect(await runPageAction("tasks.write", { op: "stop", workerId: "d1" }, ctx, d)).toEqual({ done: "Stopped “Example: d1”" });
  expect(await runPageAction("tasks.write", { op: "add", agentId: "ed", text: "Write the launch post" }, ctx, d)).toEqual({ done: "Asked ed to run" });
  expect(calls.map((c) => c[0])).toEqual(["answerInWords", "stopRow", "send"]);
  await expect(runPageAction("tasks.write", { op: "delete", workerId: "d1" }, ctx, d)).rejects.toThrow("A page can answer, stop or add a task (op: answer, stop or add).");
});
