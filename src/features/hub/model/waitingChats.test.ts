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
  chatQuestionVeto,
  findWaitingChat,
  gateLog,
  forgetWaitingChat,
  noteChats,
  openWaitingChat,
  pruneWaitingChats,
  resetWaitingChats,
  setWaitingChatsHost,
  setCaptainDoor,
  setWorkerQuestionRouter,
  subscribeWaitingChats,
  takePick,
  waitingChats,
  type WaitingChatsHost,
} from "./waitingChats";

const PROJECTS: HubProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/Users/someone/Projects/vg-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/Users/someone/Projects/hivra" },
];

const ask = (requestId = 3, prompt = "Which boss comes first?"): UserQuestionPrompt => ({
  requestId,
  questions: [
    { id: prompt, prompt, multiSelect: false, allowCustom: true, options: [{ id: "Shield (Recommended)", label: "Shield (Recommended)" }, { id: "Flier", label: "Flier" }] },
  ],
});

type Chat = Parameters<typeof noteChats>[0][number];
const chat = (over: Partial<Chat> & { id: string }): Chat => ({ cwd: "/Users/someone/Projects/vg-game", title: "claude · Boss fight", harness: "claude", blocks: [], ...over });
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
  setCaptainDoor(null);
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
});

describe("which chats are waiting", () => {
  it("lists a live question and a Needs Ash line, each under its project, with the question and the pick", () => {
    noteChats([
      chat({ id: "s1", busy: true, pendingQuestion: ask() }),
      markerChat("s2", "Needs Ash: Keep the old waitlist page?\nMy pick: Archive it.", { cwd: "/Users/someone/Projects/hivra", title: "claude · Waitlist" }),
      markerChat("s3", "All done."),
    ], 1000);
    expect(waitingChats().map((c) => [c.sessionId, c.projectName, c.chatName, c.question, c.pick])).toEqual([
      ["s1", "EXO", "Boss fight", "Which boss comes first?", "Shield"],
      ["s2", "Hivra", "Waitlist", "Keep the old waitlist page?", "Archive it."],
    ]);
    expect(waitingChats("hivra").map((c) => c.sessionId)).toEqual(["s2"]);
  });

  it("a Mono's chat is named after the Mono and filed under the project it leads", () => {
    addMono({ id: "vg-game-lead", name: "EXO lead", mascot: "robot", color: "#888", projects: ["/Users/someone/Projects/vg-game"], sessionId: "lead-chat" });
    noteChats([markerChat("lead-chat", "Needs Ash: Cut Area 3 from the demo?\nMy pick: Cut it.", { cwd: "/Users/someone" })]);
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

describe("the gate: only what needs Ash reaches Needs you (D3)", () => {
  it("a plain progress update cannot reach Needs you, and both decisions are recorded", () => {
    noteChats([
      markerChat("progress", "Needs Ash: Working on the docs; next I'll run the checks."),
      markerChat("real", "Needs Ash: Which export format?\nMy pick: CSV"),
    ], 1000);
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["real"]);
    expect(findWaitingChat("progress")).toBeUndefined();

    const held = gateLog().find((r) => r.sessionId === "progress")!;
    expect(held).toMatchObject({ admit: false, question: "Working on the docs; next I'll run the checks." });
    expect(held.reason).toMatch(/progress update/);
    expect(held.reason).toMatch(/stays in the chat/);

    const letThrough = gateLog().find((r) => r.sessionId === "real")!;
    expect(letThrough).toMatchObject({ admit: true, kind: "choice" });
    expect(findWaitingChat("real")?.gate).toMatchObject({ kind: "choice" });
  });

  it("an approval with no recommendation is refused in plain words", () => {
    noteChats([markerChat("approve", "Needs Ash: May I restart the staging server?")], 1000);
    expect(waitingChats()).toEqual([]);
    const held = gateLog()[0];
    expect(held.admit).toBe(false);
    expect(held.reason).toMatch(/no recommendation/);
    expect(held.reason).toMatch(/stays in the chat/);
  });

  it("records a question once, however many streamed words report it", () => {
    const text = "Needs Ash: Working on the docs.";
    noteChats([markerChat("p", text)], 1000);
    noteChats([markerChat("p", text)], 2000);
    expect(gateLog().filter((r) => r.sessionId === "p")).toHaveLength(1);
  });

  it("a listed question that turns into a progress line leaves Needs you", () => {
    noteChats([markerChat("s", "Needs Ash: Keep it?\nMy pick: Keep it.")], 1000);
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["s"]);
    noteChats([markerChat("s", "Needs Ash: Working on the docs; next I'll run the checks.")], 2000);
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

  it("a Needs Ash line asked with buttons too doesn't come back once the buttons were answered (r81, s14)", async () => {
    const { live } = host();
    const q = "Should a deleted tally be gone for good, or kept for 30 days?";
    const blocks = [{ role: "user" as const, text: "add delete", startedAt: 1 }, { role: "assistant" as const, text: `Needs Ash: ${q.toLowerCase()}\nMy pick: gone for good.` }];
    live.set("s1", ask(4, q));
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask(4, q), blocks })]);
    expect((await answerInWords("s1", "keep them 30 days so i can undo")).ok).toBe(true);
    noteChats([chat({ id: "s1", busy: true, blocks })]);
    noteChats([chat({ id: "s1", busy: false, blocks })]);
    expect(waitingChats()).toEqual([]);
    // A new turn from Ash that asks again does wait.
    const later = [...blocks, { role: "user" as const, text: "actually ask me again", startedAt: Date.now() + 60_000 }, blocks[1]];
    noteChats([chat({ id: "s1", busy: false, blocks: later })]);
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["s1"]);
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
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() }), markerChat("s2", "Needs Ash: Keep it?\nMy pick: Keep it.")]);
    await answerInWords("s1", "Flier, slower");
    await answerInWords("s2", "keep it for a week");
    expect(calls.respond[0][2]).toEqual({ kind: "answered", answers: { "Which boss comes first?": ["__custom__"] }, custom: { "Which boss comes first?": "Flier, slower" } });
    expect(calls.send).toEqual([["s2", "keep it for a week"]]);
  });

  it("records Ash's typed words as the decision, not the agent's recommended pick (r80, s14: Today showed Gone for good)", async () => {
    const { live } = host();
    live.set("s1", ask());
    noteChats([chat({ id: "s1", busy: true, pendingQuestion: ask() }), markerChat("s2", "Needs Ash: Keep it?\nMy pick: Keep it.")]);
    await answerInWords("s1", "flier first, then the shield");
    await takePick("s2");
    const s1 = gateLog().filter((r) => r.sessionId === "s1").at(-1)!;
    expect(s1.pick).toBe("Shield");
    expect(s1.answer).toMatchObject({ words: "flier first, then the shield", by: "words" });
    expect(gateLog().filter((r) => r.sessionId === "s2").at(-1)!.answer).toMatchObject({ words: "Keep it.", by: "pick" });
  });

  it("an errand with no pick, an empty reply, a chat that can't take a message: it stays waiting with a plain reason", async () => {
    host({ send: async () => false });
    // A sign-in is admitted without a pick (the errand is the recommendation), so Take the pick has nothing to take.
    noteChats([markerChat("s2", "Needs Ash (sign in): Log in to Vercel?"), markerChat("s3", "Needs Ash: Q?\nMy pick: A")]);
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

  it("Autopilot never takes a pick that sends, deletes, moves money, publishes or changes access (WP-101, row 19)", async () => {
    const { calls } = host();
    noteChats([
      markerChat("mail", "Needs Ash: Send the invoice to Priya?\nMy pick: yes, send it"),
      markerChat("notes", "Needs Ash: What next?\nMy pick: publish the release notes"),
      markerChat("branch", "Needs Ash: Delete the old branch?\nMy pick: yes"),
      markerChat("changelog", "Needs Ash: Next step?\nMy pick: keep it"),
      markerChat("fine", "Needs Ash: Keep the old endpoint for a week?\nMy pick: yes"),
    ]);
    const vetoed = ["mail", "notes", "branch"];
    for (const id of vetoed) {
      const chat = findWaitingChat(id)!;
      expect(autopilotMayTake(chat), id).toBe(false);
      // Held either by the red line's own words or by the reviewer rule; both leave it for Ash.
      const result = await takePick(id, { by: "autopilot" });
      expect(result.ok, id).toBe(false);
      if (!chat.redLine) expect(result, id).toEqual({ ok: false, reason: "That one sends, deletes, moves money, publishes or changes access, so it waits for Ash." });
    }
    expect(autopilotMayTake(findWaitingChat("fine")!)).toBe(true);
    expect((await takePick("fine", { by: "autopilot" })).ok).toBe(true);
    expect(calls.send.map(([id]) => id)).toEqual(["fine"]);
    // Ash may still take a vetoed one himself: the rule only narrows what autopilot does.
    for (const id of vetoed) expect((await takePick(id)).ok, id).toBe(true);
  });

  // WP-101 fix round 2, item F (N10): a chat's stored shape is read from disk and may have been written by an older
  // build or edited by hand. A shape the veto can't read is a hold with a reason, never an exception: `autopilotMayTake`
  // runs in render code, where a throw breaks a list rather than just waiting.
  it("holds any chat shape it can't read, with a reason, instead of throwing (fix round 2, item F)", async () => {
    const hostile = {
      get question(): string {
        throw new Error("a getter that throws");
      },
      pick: "yes",
    };
    const shapes: unknown[] = [
      null,
      undefined,
      7,
      "ship it",
      {},
      { question: "" },
      { question: "Which first?", options: 5 },
      { question: "Which first?", rows: 5 },
      { question: "Which first?", rows: [null] },
      { question: "Which first?", rows: [{ options: 5 }] },
      { question: "Which first?", rows: [{ question: 7 }] },
      { question: 7 },
      hostile,
    ];
    for (const shape of shapes) {
      const label = shape === hostile ? "a throwing getter" : JSON.stringify(shape) ?? "undefined";
      expect(() => chatQuestionVeto(shape as never), label).not.toThrow();
      expect(chatQuestionVeto(shape as never), label).toBe("The reviewer couldn't read what this would do, so it waits for you.");
      expect(() => autopilotMayTake(shape as never), label).not.toThrow();
      expect(autopilotMayTake(shape as never), label).toBe(false);
    }
    // A shape that is readable and names no action is still a plain null: the rule only holds what it can't read.
    expect(chatQuestionVeto({ question: "Which first?" })).toBeNull();
    // The list itself is render code: one unreadable saved chat doesn't take it down.
    expect(() => waitingChats()).not.toThrow();
  });

  it("holds a saved chat whose rows hold an action, and one whose rows it can't read, on the same door (item F)", async () => {
    host();
    noteChats([markerChat("rows", "Needs Ash: What next?\nMy pick: keep it")]);
    const chat = findWaitingChat("rows")!;
    // A card whose other row is a send: taking this pick answers a card that names it.
    expect(chatQuestionVeto({ ...chat, rows: [{ question: "Anything else?", redLine: false }, { question: "Ping Priya?", redLine: false }] })).not.toBeNull();
    // A row whose own text can't be read: held too, never passed.
    expect(chatQuestionVeto({ ...chat, rows: [{ question: 7, redLine: false } as never] })).not.toBeNull();
    expect(chatQuestionVeto({ ...chat, rows: [{ question: "Rename the file?", redLine: false }] })).toBeNull();
    // And `takePick` by autopilot says so plainly: a hold, not a rejection.
    expect(await takePick("rows", { by: "autopilot" })).toMatchObject({ ok: true });
  });

  it("a standing answer is sent instead of the pick, and an owner key is not taken", async () => {
    const { calls } = host();
    setCaptainDoor((chat) =>
      chat.sessionId === "own" ? { decisionKey: "secret/token" } : { standing: { answer: "Example: keep it", label: "merge on green" } },
    );
    noteChats([
      markerChat("stand", "Needs Ash: Example: keep the gate?\nMy pick: Example: change it"),
      markerChat("own", "Needs Ash: Example: which name?\nMy pick: Example: keep it"),
    ]);
    expect(await takePick("stand", { by: "autopilot" })).toMatchObject({ ok: true, sent: "Example: keep it" });
    expect(await takePick("own", { by: "autopilot" })).toMatchObject({ ok: false });
    expect(calls.send.map(([id]) => id)).toEqual(["stand"]);
  });

  it("the captain is refused by the same veto and person-only check a Page is", async () => {
    const { calls } = host();
    const standing = { answer: "Example: keep it", label: "merge on green" };
    setCaptainDoor(() => ({ monoId: "ada", standing }));
    noteChats([
      markerChat("pub", "Needs Ash: What next?\nMy pick: merge it"),
      markerChat("pub-page", "Needs Ash: What next?\nMy pick: merge it"),
    ]);
    const pub = findWaitingChat("pub")!;
    expect(pub.redLine, "this one is the veto, not the red line").toBe(false);
    expect(chatQuestionVeto(pub)).not.toBeNull();
    const captain = await takePick("pub", { by: "autopilot" });
    const page = await takePick("pub-page", { by: "page" });
    expect(captain).toEqual(page);
    expect(captain).toEqual({
      ok: false,
      reason: "That one sends, deletes, moves money, publishes or changes access, so it waits for Ash.",
    });
    expect(calls.send).toEqual([]);

    for (const key of ["gate/run-7", "Gate/run-7", "irreversible/lead/task-6", "fresh-eyes/r9/00112233aabbccdd", "fanout-again/fm/task-2"]) {
      const id = `own-${key.replace(/[^a-z0-9]+/gi, "-")}`;
      setCaptainDoor(() => ({ decisionKey: key, monoId: "ada", standing }));
      noteChats([markerChat(id, "Needs Ash: Example: which name?\nMy pick: Example: keep it")]);
      expect(await takePick(id, { by: "autopilot" }), key).toEqual({
        ok: false,
        reason: "Only you can answer that one. Open Needs you to answer it.",
      });
    }
    expect(calls.send).toEqual([]);
  });

  it("a captain answer is stored as captain:<id>, never as the person or a page", async () => {
    const { calls } = host();
    const standing = { answer: "Example: keep it", label: "merge on green" };
    setCaptainDoor(() => ({ monoId: "ada", standing }));
    noteChats([markerChat("id", "Needs Ash: Example: keep the gate?\nMy pick: Example: change it")]);
    expect(await takePick("id", { by: "autopilot" })).toMatchObject({ ok: true, sent: "Example: keep it" });
    expect(gateLog().find((row) => row.sessionId === "id")?.answer).toMatchObject({ words: "Example: keep it", who: "captain:ada" });

    setCaptainDoor(() => ({ monoId: "ada" }));
    noteChats([markerChat("same", "Needs Ash: Rename the file?\nMy pick: yes")]);
    expect((await takePick("same", { by: "autopilot" })).ok).toBe(true);
    expect(gateLog().find((row) => row.sessionId === "same")?.answer?.who).toBe("captain:ada");

    for (const monoId of ["page:ada", "user", "person", "page", ""]) {
      const id = `bad-${monoId || "blank"}`;
      setCaptainDoor(() => ({ monoId, standing }));
      noteChats([markerChat(id, "Needs Ash: Example: keep the gate?\nMy pick: Example: change it")]);
      expect((await takePick(id, { by: "autopilot" })).ok, monoId || "blank").toBe(true);
      const who = gateLog().find((row) => row.sessionId === id)?.answer?.who;
      expect(who, monoId || "blank").toBe("captain:chief");
    }
    expect(calls.send.map(([id]) => id)).toContain("id");
    expect(calls.send.map(([, text]) => text).join("\n")).not.toContain("page:");
  });

  it("keeps pager as a mono id, and does not read it as a page", async () => {
    host();
    const stop = setCaptainDoor(() => ({ monoId: "pager", standing: { answer: "Example: keep it", label: "merge on green" } }));
    try {
      noteChats([markerChat("pager-1", "Needs Ash: Example: keep the gate?\nMy pick: Example: change it")]);
      expect(await takePick("pager-1", { by: "autopilot" })).toMatchObject({ ok: true, sent: "Example: keep it" });
      expect(gateLog().find((row) => row.sessionId === "pager-1")?.answer?.who).toBe("captain:pager");
    } finally {
      stop();
    }
  });

  it("a worker's question H4 routes to its Lead is not Ash's", () => {
    setWorkerQuestionRouter((c) => c.sessionId === "worker");
    noteChats([markerChat("worker", "Needs Ash: Which test runner?\nMy pick: vitest"), markerChat("lead", "Needs Ash: Ship it?\nMy pick: yes")]);
    expect(waitingChats().map((c) => c.sessionId)).toEqual(["lead"]);
  });

  it("Open hands the chat to the app", () => {
    const { calls } = host();
    noteChats([markerChat("s2", "Needs Ash: Q?\nMy pick: A")]);
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
