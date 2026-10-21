// @vitest-environment happy-dom
// "Waiting on you": the chats whose agent asked Ash something, filed under their project, answered from Today (in place
// when the question is live, as a message otherwise), kept across a restart, and the hooks Autopilot and H4 use.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMono } from "../../monos/model/mono";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import {
  answerInWords,
  autopilotMayTake,
  findWaitingChat,
  forgetWaitingChat,
  noteChats,
  openWaitingChat,
  pruneWaitingChats,
  resetWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
  subscribeWaitingChats,
  takePick,
  waitingChats,
  type WaitingChatsHost,
} from "./waitingChats";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/Users/ash/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/Users/ash/Projects/hivra" },
];

const ask = (requestId = 3, prompt = "Which boss comes first?"): UserQuestionPrompt => ({
  requestId,
  questions: [
    { id: prompt, prompt, multiSelect: false, allowCustom: true, options: [{ id: "Shield (Recommended)", label: "Shield (Recommended)" }, { id: "Flier", label: "Flier" }] },
  ],
});

type Chat = Parameters<typeof noteChats>[0][number];
const chat = (over: Partial<Chat> & { id: string }): Chat => ({ cwd: "/Users/ash/Projects/vg-game", title: "claude · Boss fight", harness: "claude", blocks: [], ...over });
const markerChat = (id: string, text: string, over: Partial<Chat> = {}) =>
  chat({ id, blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text }], ...over });

function host(over: Partial<WaitingChatsHost> = {}) {
  const live = new Map<string, UserQuestionPrompt>();
  const calls = { respond: [] as [string, number, UserQuestionReply][], send: [] as [string, string][], open: [] as string[] };
  const h: WaitingChatsHost = {
    liveQuestion: (id) => live.get(id),
    respond: (id, requestId, reply) => void calls.respond.push([id, requestId, reply]),
    send: async (id, text) => (calls.send.push([id, text]), true),
    open: (id, projectId) => void calls.open.push(`${id}@${projectId}`),
    ...over,
  };
  setWaitingChatsHost(h);
  return { live, calls };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
});

describe("which chats are waiting", () => {
  it("lists a live question and a Needs Ash line, each under its project, with the question and the pick", () => {
    noteChats([
      chat({ id: "s1", busy: true, pendingQuestion: ask() }),
      markerChat("s2", "Needs Ash: Keep the old waitlist page?\nMy pick: Archive it.", { cwd: "/Users/ash/Projects/hivra", title: "claude · Waitlist" }),
      markerChat("s3", "All done."),
    ], 1000);
    expect(waitingChats().map((c) => [c.sessionId, c.projectName, c.chatName, c.question, c.pick])).toEqual([
      ["s1", "EXO", "Boss fight", "Which boss comes first?", "Shield"],
      ["s2", "Hivra", "Waitlist", "Keep the old waitlist page?", "Archive it."],
    ]);
    expect(waitingChats("hivra").map((c) => c.sessionId)).toEqual(["s2"]);
  });

  it("a Mono's chat is named after the Mono and filed under the project it leads", () => {
    addMono({ id: "vg-game-lead", name: "EXO lead", mascot: "robot", color: "#888", projects: ["/Users/ash/Projects/vg-game"], sessionId: "lead-chat" });
    noteChats([markerChat("lead-chat", "Needs Ash: Cut Area 3 from the demo?\nMy pick: Cut it.", { cwd: "/Users/ash" })]);
    expect(waitingChats().map((c) => [c.chatName, c.projectId])).toEqual([["EXO lead", "vg-game"]]);
  });

  it("habit runs, inbox discussions and orchestration workers never wait here", () => {
    noteChats([
      chat({ id: "h", ephemeral: true, pendingQuestion: ask() }),
      chat({ id: "i", inboxAsk: { key: "k" } as never, pendingQuestion: ask() }),
      chat({ id: "w", orchestrationLeadId: "lead", pendingQuestion: ask() }),
    ]);
    expect(waitingChats()).toEqual([]);
  });

  it("a chat stops waiting once it moves on: answered in place, a new turn, or Ash's reply", () => {
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() }), markerChat("s2", "Needs Ash: Q?\nMy pick: A")], 1000);
    // s1 answered in the chat itself (the turn goes on); s2 got Ash's reply
    noteChats([
      chat({ id: "s1", busy: true }),
      chat({ id: "s2", blocks: [{ role: "user", text: "go", startedAt: 1 }, { role: "assistant", text: "Needs Ash: Q?\nMy pick: A" }, { role: "user", text: "A", startedAt: 2000 }] }),
    ], 2000);
    expect(waitingChats()).toEqual([]);
  });

  it("an asked question survives a restart and is answered with a message once its turn is gone", async () => {
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask(), blocks: [{ role: "user", text: "go", startedAt: 1 }] })], 1000);
    resetWaitingChats(); // the app restarts: the list comes back from storage
    expect(findWaitingChat("s1")?.requestId).toBe(3);
    // reopened after the restart: no live question, nothing said since, no turn running
    noteChats([chat({ id: "s1", busy: false, blocks: [{ role: "user", text: "go", startedAt: 1 }] })], 5000);
    const waiting = findWaitingChat("s1")!;
    expect(waiting.question).toBe("Which boss comes first?");
    expect(waiting.requestId).toBeUndefined();
    const { calls } = host();
    expect(await takePick("s1")).toEqual({ ok: true, sent: 'About your question "Which boss comes first?": go with your pick, Shield', chatName: "Boss fight" });
    expect(calls.send).toEqual([["s1", 'About your question "Which boss comes first?": go with your pick, Shield']]);
    expect(waitingChats()).toEqual([]);
  });

  it("a question seen live and then gone in this run was answered or stopped: it is not kept", () => {
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() })], 1000);
    noteChats([chat({ id: "s1", busy: false })], 2000);
    expect(waitingChats()).toEqual([]);
  });
});

describe("a chat that is gone", () => {
  it("leaves Today when it is archived or deleted, and stays gone after a restart", () => {
    noteChats([markerChat("s1", "Needs Ash: Ship it?\nMy pick: Yes."), markerChat("s2", "Needs Ash: Rename it?\nMy pick: No.")]);
    forgetWaitingChat("s1");
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["s2"]);
    resetWaitingChats();
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["s2"]);
  });

  it("is pruned when its saved conversation no longer exists; one that couldn't be looked up stays", async () => {
    noteChats([
      markerChat("gone", "Needs Ash: Ship it?\nMy pick: Yes."),
      markerChat("here", "Needs Ash: Rename it?\nMy pick: No."),
      markerChat("unknown", "Needs Ash: Merge it?\nMy pick: Yes."),
    ]);
    await pruneWaitingChats(async (id) => {
      if (id === "unknown") throw new Error("database is locked");
      return id === "here";
    });
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["here", "unknown"]);
  });
});

describe("answering from Today", () => {
  it("Take the pick answers a live question in place with the recommended option", async () => {
    const { live, calls } = host();
    live.set("s1", ask());
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() })]);
    const res = await takePick("s1");
    expect(res.ok).toBe(true);
    expect(calls.respond).toEqual([["s1", 3, { kind: "answered", answers: { "Which boss comes first?": ["Shield (Recommended)"] } }]]);
    expect(calls.send).toEqual([]);
    expect(waitingChats()).toEqual([]);
  });

  it("Take the pick on a Needs Ash line sends Ash's go into that chat", async () => {
    const { calls } = host();
    noteChats([markerChat("s2", "Needs Ash: Keep it?\nMy pick: Archive it.")]);
    await takePick("s2");
    expect(calls.send).toEqual([["s2", "Go with your pick: Archive it."]]);
  });

  it("a reply in Ash's words answers in place, or goes as his message", async () => {
    const { live, calls } = host();
    live.set("s1", ask());
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() }), markerChat("s2", "Needs Ash: Keep it?")]);
    await answerInWords("s1", "Flier, slower");
    await answerInWords("s2", "keep it for a week");
    expect(calls.respond[0][2]).toEqual({ kind: "answered", answers: { "Which boss comes first?": ["__custom__"] }, custom: { "Which boss comes first?": "Flier, slower" } });
    expect(calls.send).toEqual([["s2", "keep it for a week"]]);
  });

  it("no pick, an empty reply, a chat that can't take a message: it stays waiting with a plain reason", async () => {
    host({ send: async () => false });
    noteChats([markerChat("s2", "Needs Ash: Keep it?"), markerChat("s3", "Needs Ash: Q?\nMy pick: A")]);
    expect(await takePick("s2")).toEqual({ ok: false, reason: "The agent didn't suggest an answer. Reply in your words or open the chat." });
    expect(await answerInWords("s2", "  ")).toEqual({ ok: false, reason: "Type an answer first." });
    expect(await takePick("s3")).toEqual({ ok: false, reason: "Boss fight couldn't take a message right now. Open the chat to answer." });
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["s2", "s3"]);
  });

  it("several waiting chats clear in a row", async () => {
    const { calls } = host();
    noteChats([markerChat("a", "Needs Ash: A?\nMy pick: yes"), markerChat("b", "Needs Ash: B?\nMy pick: no"), markerChat("c", "Needs Ash: C?\nMy pick: later")]);
    for (const c of waitingChats()) await takePick(c.sessionId);
    expect(calls.send.map(([id]) => id)).toEqual(["a", "b", "c"]);
    expect(waitingChats()).toEqual([]);
  });
});

describe("hooks for Autopilot and H4", () => {
  it("Autopilot takes picks but never a red line, and hears every change", async () => {
    const { calls } = host();
    const heard = vi.fn();
    const off = subscribeWaitingChats(heard);
    noteChats([markerChat("ok", "Needs Ash: Rename the file?\nMy pick: yes"), markerChat("red", "Needs Ash: Email every customer about the delay?\nMy pick: yes")]);
    expect(heard).toHaveBeenCalled();
    const [plain, red] = [findWaitingChat("ok")!, findWaitingChat("red")!];
    expect([autopilotMayTake(plain), autopilotMayTake(red)]).toEqual([true, false]);
    expect(await takePick("red", { by: "autopilot" })).toEqual({ ok: false, reason: "This one touches a red line, so it waits for Ash." });
    expect((await takePick("ok", { by: "autopilot" })).ok).toBe(true);
    expect(await takePick("red")).toMatchObject({ ok: true }); // Ash himself may take it
    expect(calls.send.map(([id]) => id)).toEqual(["ok", "red"]);
    off();
  });

  it("a worker's question H4 routes to its Lead is not Ash's", () => {
    setWorkerQuestionRouter((c) => c.sessionId === "worker");
    noteChats([markerChat("worker", "Needs Ash: Which test runner?\nMy pick: vitest"), markerChat("lead", "Needs Ash: Ship it?\nMy pick: yes")]);
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["lead"]);
  });

  it("Open hands the chat to the app", () => {
    const { calls } = host();
    noteChats([markerChat("s2", "Needs Ash: Q?")]);
    openWaitingChat("s2");
    expect(calls.open).toEqual(["s2@vg-game"]);
  });
});

describe("a red-line ask is answered with an explicit choice (port map idea 3)", () => {
  it("Approve once and Deny each send their own words; a changed ask is refused", async () => {
    const { answerApproval, approvalMessage } = await import("./waitingChats");
    const { calls } = host();
    noteChats([markerChat("r1", "Needs Ash (red line): Email the waitlist about the delay?\nMy pick: Send it Friday.")], 1000);
    const seen = findWaitingChat("r1")!;
    expect(seen.redLine).toBe(true);
    expect(approvalMessage("approve-once", seen)).toBe("Approved, this once: Send it Friday.");
    expect(approvalMessage("deny", seen)).toBe("Denied: don't do this. (Email the waitlist about the delay?)");
    // The ask moved on before the click: refused, nothing sent.
    noteChats([markerChat("r1", "Needs Ash (red line): Email the whole list today instead?\nMy pick: Send it now.")], 2000);
    const stale = await answerApproval("r1", "approve-once", seen);
    expect(stale).toEqual({ ok: false, reason: "That changed while you were looking. Open the chat to see where it stands." });
    expect(calls.send).toEqual([]);
    const fresh = findWaitingChat("r1")!;
    expect(await answerApproval("r1", "deny", fresh)).toMatchObject({ ok: true });
    expect(calls.send).toEqual([["r1", "Denied: don't do this. (Email the whole list today instead?)"]]);
  });
});
