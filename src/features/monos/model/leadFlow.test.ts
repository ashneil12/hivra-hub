// Coding with a Lead (Ash, 20 Oct: "a good chat and delegate if needed as per the orchestrator stuff and still chat"):
// Ash's own messages never wait behind the app's deliveries, and a message he steers into the Lead's last turn never
// cuts the Lead's report to leadership short.
import { describe, expect, it } from "vitest";
import { canDispatchQueuedHead, canSteerQueuedHead, queuedHead } from "../../sessions/model/messageQueue";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { newSession, type Block, type QueuedMessage, type Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { FOLLOW_GRACE_MS, followStep, REPORT_REQUEST_PREFIX, reportRequestId } from "./followedBriefs";
import { claimsDone, stillRunningNote, workingLine, workingOn } from "./leadFlow";
import { enqueueMonoMessage } from "./monoMessaging";
import {
  completionMessage,
  completionReceipt,
  enqueueMonoSessionCompletion,
  MonoSessionCompletionBatches,
  monoSessionCompletionResult,
  REPORT_WINDOW_MS,
} from "./monoSessionCompletion";

function lead(extra: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/p/hub"), id: "lead-chat", title: "MonoCode Hub lead", ...extra };
}

function report(requestId: string, text = `Result ${requestId}`): QueuedMessage {
  return completionMessage(completionReceipt(requestId), [
    monoSessionCompletionResult({
      requestId,
      sessionId: `app-lead-chat-${requestId}`,
      project: "/p/hub",
      prompt: `Do ${requestId}`,
      outcome: { status: "completed", text },
    }),
  ]);
}

const ash = (id: string, text = id): QueuedMessage => ({ id, text, attachments: [] });

describe("Ash's own message goes first (gap a)", () => {
  it("a Lead mid-turn with a worker's report waiting: Ash's message is the head and steers into the running turn", () => {
    const busy = lead({ busy: true, turnReady: true, queuedMessages: [report("api")], queueStatus: "active" });
    // Before: only the head can steer and a report never steers, so Ash waited for the whole turn and the report's.
    expect(canSteerQueuedHead(busy)).toBe(false);
    const next = enqueueMonoMessage(busy, ash("ash-1", "How's it going?"));
    expect(queuedHead(next)?.id).toBe("ash-1");
    expect(canSteerQueuedHead(next)).toBe(true);
    // The report keeps its place behind him; his bubble shows at once.
    expect(next.queuedMessages?.map((m) => m.id)).toEqual(["ash-1", completionReceipt("api")]);
    expect(next.blocks.at(-1)).toMatchObject({ role: "user", text: "How's it going?" });
  });

  it("goes ahead of reports, question wakes and waiting briefs, but never ahead of his own earlier messages", () => {
    const wake: QueuedMessage = {
      id: "question-w-1",
      text: "[MonoCode question] ...",
      attachments: [],
      monoSessionCompletion: { sessionId: "w", title: "UI", status: "completed", question: true },
    };
    const brief: QueuedMessage = { id: "app-cos-b1", appRequestId: "app-cos-b1", text: "[MonoCode brief from Chief of Staff]", attachments: [], waitForIdle: true };
    const steerBrief: QueuedMessage = { id: "app-pm-b2", appRequestId: "app-pm-b2", text: "[MonoCode brief from PM]", attachments: [] };
    let chat = lead({ busy: true, turnReady: true, queuedMessages: [report("api"), wake, brief, steerBrief], queueStatus: "active" });
    chat = enqueueMonoMessage(chat, ash("ash-1"));
    chat = enqueueMonoMessage(chat, ash("ash-2"));
    expect(chat.queuedMessages?.map((m) => m.id)).toEqual(["ash-1", "ash-2", completionReceipt("api"), "question-w-1", "app-cos-b1", "app-pm-b2"]);
    // An app brief sent in steer mode is not Ash's: it goes to the back, as before.
    const later = enqueueMonoMessage(chat, { ...steerBrief, id: "app-pm-b3", appRequestId: "app-pm-b3" });
    expect(later.queuedMessages?.at(-1)?.id).toBe("app-pm-b3");
  });

  it("an idle Lead whose queue holds a report sends Ash's message as the next turn", () => {
    const idle = lead({ queuedMessages: [report("api")], queueStatus: "active", usageLimit: undefined });
    const next = enqueueMonoMessage(idle, ash("ash-1"));
    expect(queuedHead(next)?.id).toBe("ash-1");
    expect(canDispatchQueuedHead(next)).toBe(true);
  });
});

const user = (text: string, appRequestId?: string, extra: Partial<Block> = {}): Block => ({
  id: crypto.randomUUID(),
  role: "user",
  text,
  startedAt: 1,
  ...(appRequestId ? { appRequestId } : {}),
  ...extra,
});
/** A message that joined a running turn (appendSteerUser): sent, never started. */
const steer = (text: string): Block => ({ id: crypto.randomUUID(), role: "user", text, sentAt: 2 });
const said = (text: string): Block => ({ id: crypto.randomUUID(), role: "assistant", text });

function leadBrief(over: Partial<Delegation> = {}): Delegation {
  return {
    id: "t-1",
    ownerSession: "cos-chat",
    ownerMono: "chief-of-staff",
    batchId: null,
    parentId: null,
    rootId: "t-1",
    childSession: "lead-chat",
    requestId: "app-cos-chat-b1",
    generation: 1,
    project: "hub",
    title: "Ship the API and UI",
    brief: "[MonoCode brief from Chief of Staff]\n\nShip the API and UI",
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 10_000,
    updatedAt: 10_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    follow: "lead",
    ...over,
  };
}

function worker(id: string, receipt: string): Delegation {
  return leadBrief({
    id,
    parentId: "t-1",
    ownerSession: "lead-chat",
    childSession: `app-lead-chat-${id}`,
    requestId: id,
    follow: null,
    state: "completed",
    delivery: "delivered",
    deliveryMessage: receipt,
  });
}

describe("a steer into the Lead's last turn never truncates its report (gap b)", () => {
  const brief = leadBrief();
  const api = worker("w-api", "mono-completion-w-api-g1");
  const ui = worker("w-ui", "mono-completion-w-ui-g1");
  const children = [brief, api, ui];
  const opening = [
    user(brief.brief!, brief.requestId),
    said("Started API and UI workers."),
    user("[MonoCode report] api", "mono-completion-w-api-g1"),
    said("API is back; UI still running."),
  ];
  const finalTurn = [
    ...opening,
    user("[MonoCode report] ui", "mono-completion-w-ui-g1"),
    said("Both back. Writing the final report."),
    steer("Ash: is the UI done?"),
    said("Yes, the UI just landed."),
    said("FINAL: API and UI shipped, checks green at abc123."),
  ];
  const look = (blocks: Block[], extra: Partial<Session> = {}, asked?: Map<string, number>, now = 0) =>
    followStep(brief, { chat: lead({ blocks, ...extra }), children, now, ...(asked ? { asked } : {}) });

  it("does not settle on the words before Ash's message: it asks the Lead for its report on its own, once", () => {
    const step = look(finalTurn);
    // Before: the report stopped at Ash's bubble: "Both back. Writing the final report."
    expect(step.kind).toBe("ask");
    if (step.kind !== "ask") throw new Error("expected ask");
    expect(step.request.id).toBe(reportRequestId(brief));
    expect(step.request.monoSessionCompletion).toMatchObject({ title: "Report for Chief of Staff" });
    expect(step.request.text.startsWith(REPORT_REQUEST_PREFIX)).toBe(true);
    expect(step.request.text).toContain('"Ship the API and UI" from Chief of Staff');
    // Queued: it waits for it. Just asked but not in the queue yet: it waits too, then (taken out) settles anyway.
    expect(look(finalTurn, { queuedMessages: [step.request] })).toEqual({ kind: "wait", why: "report" });
    const asked = new Map([[step.request.id, 1_000]]);
    expect(look(finalTurn, {}, asked, 1_000 + FOLLOW_GRACE_MS - 1)).toEqual({ kind: "wait", why: "report" });
    expect(look(finalTurn, {}, asked, 1_000 + FOLLOW_GRACE_MS + 1)).toMatchObject({
      kind: "settle",
      result: { result: "FINAL: API and UI shipped, checks green at abc123." },
    });
  });

  it("the report is the Lead's answer to the request, even when Ash steers into that turn too", () => {
    const id = reportRequestId(brief);
    const asked = [...finalTurn, user("[MonoCode report request] ...", id, { internal: true }), said("Report: API and UI shipped; evidence abc123; nothing open.")];
    expect(look(asked, { busy: true })).toEqual({ kind: "wait", why: "working" });
    expect(look(asked)).toMatchObject({
      kind: "settle",
      result: { status: "completed", result: "Report: API and UI shipped; evidence abc123; nothing open." },
    });
    const steeredAgain = [...asked, steer("Ash: thanks, and the docs?"), said("Docs are next.")];
    expect(look(steeredAgain)).toMatchObject({ kind: "settle", result: { result: "Report: API and UI shipped; evidence abc123; nothing open." } });
  });

  it("a clean last turn settles on its whole reply: a later message of Ash's as its own turn, or one still waiting, is not part of it", () => {
    const clean = [...opening, user("[MonoCode report] ui", "mono-completion-w-ui-g1"), said("Both back."), said("FINAL: shipped.")];
    expect(look(clean)).toMatchObject({ kind: "settle", result: { result: "FINAL: shipped." } });
    // Ash's next message, sent after the report turn ended, went in as a turn of its own.
    expect(look([...clean, user("Ash: great, what next?"), said("Docs.")])).toMatchObject({ kind: "settle", result: { result: "FINAL: shipped." } });
    // A message of his still waiting in the queue shows where he sent it, mid-turn; it isn't in the conversation yet.
    const waiting = { ...steer("Ash: done yet?"), id: "pending-ash" };
    const blocks = [...opening, user("[MonoCode report] ui", "mono-completion-w-ui-g1"), said("Both back."), waiting, said("FINAL: shipped.")];
    expect(look(blocks, { queuedMessages: [{ id: "q", blockId: "pending-ash", text: "Ash: done yet?", attachments: [] }] })).toMatchObject({
      kind: "settle",
      result: { result: "FINAL: shipped." },
    });
  });

  it("a message that waited and went in as a new turn, sent before the report turn ended, mixes it too", () => {
    const reportBubble = user("[MonoCode report] ui", "mono-completion-w-ui-g1", { startedAt: 1_000, durationMs: 5_000 });
    const sentDuring = user("Ash: done yet?", undefined, { sentAt: 2_000, startedAt: 6_500 });
    const blocks = [...opening, reportBubble, said("Both back."), sentDuring, said("FINAL: shipped."), said("Yes, all done.")];
    expect(look(blocks).kind).toBe("ask");
    const sentAfter = user("Ash: and docs?", undefined, { sentAt: 7_000, startedAt: 7_100 });
    expect(look([...opening, reportBubble, said("FINAL: shipped."), sentAfter, said("Docs next.")])).toMatchObject({
      kind: "settle",
      result: { result: "FINAL: shipped." },
    });
  });

  it("a steer into an earlier turn of the brief changes nothing: only the last one is the report", () => {
    const blocks = [
      user(brief.brief!, brief.requestId),
      said("Started API and UI workers."),
      steer("Ash: use the new schema"),
      said("Noted, passing it on."),
      user("[MonoCode report] api", "mono-completion-w-api-g1"),
      said("API is back."),
      user("[MonoCode report] ui", "mono-completion-w-ui-g1"),
      said("FINAL: shipped with the new schema."),
    ];
    expect(look(blocks)).toMatchObject({ kind: "settle", result: { result: "FINAL: shipped with the new schema." } });
  });

  it("a brief that was itself steered into a running turn shares that turn, so its report is asked for", () => {
    const steered = { ...steer(brief.brief!), appRequestId: brief.requestId };
    const blocks = [user("Ash: tidy the docs"), said("Tidying."), steered, said("Docs tidied. Also did the brief: shipped.")];
    expect(followStep(brief, { chat: lead({ blocks }), children: [brief], now: 0 }).kind).toBe("ask");
  });
});

describe("a Lead with two workers out still chats with Ash", () => {
  it("the first worker's report reaches the Lead while the second runs, and Ash's message never waits behind it", () => {
    let at = 0;
    const timers: (() => void)[] = [];
    let chat = lead({ busy: true, turnReady: true });
    const batches = new MonoSessionCompletionBatches(
      (_, message) => {
        chat = enqueueMonoSessionCompletion(chat, message);
      },
      { now: () => at, schedule: (run) => (timers.push(run), () => undefined) },
    );
    const api = batches.watch({ monoId: chat.id, turn: 1 }, "api", "app-lead-chat-api", { title: "API" });
    batches.watch({ monoId: chat.id, turn: 1 }, "ui", "app-lead-chat-ui", { title: "UI" });
    batches.closeInactive(() => false);
    api(
      monoSessionCompletionResult({
        requestId: "api",
        sessionId: "app-lead-chat-api",
        project: "/p/hub",
        prompt: "API",
        outcome: { status: "completed", text: "API-DONE" },
      }),
    );
    at = REPORT_WINDOW_MS;
    timers.splice(0).forEach((run) => run());
    // The API report waits in the busy Lead's queue, saying the UI still runs.
    expect(chat.queuedMessages).toHaveLength(1);
    expect(chat.queuedMessages![0].text).toContain("1 of 2 back, still running: UI");
    // Ash asks how it goes: his message is the head and steers into the running turn.
    chat = enqueueMonoMessage(chat, ash("ash-1", "How's it going?"));
    expect(queuedHead(chat)?.id).toBe("ash-1");
    expect(canSteerQueuedHead(chat)).toBe(true);
  });
});

describe("says it's done while delegated work is still out (borrowed from Block's Buzz)", () => {
  it("knows a claim that the job is finished from an update that says some of it still runs", () => {
    for (const text of [
      "Done. API and UI are shipped.",
      "All done: the room ships.",
      "Everything is finished and merged.",
      "The feature is complete.",
      "That's done, nothing left to do.",
      "**Shipped**: the fix is live.",
    ])
      expect(claimsDone(text), text).toBe(true);
    for (const text of [
      "API is done; UI is still running.",
      "Started two workers. I'll report back once they finish.",
      "1 of 2 back: the API is done.",
      "Waiting on the UI worker.",
      "Not done yet.",
      "Here's the plan for the API and UI.",
    ])
      expect(claimsDone(text), text).toBe(false);
  });

  const open = (id: string, title: string, extra: Partial<Delegation> = {}) =>
    leadBrief({ id, title, ownerSession: "lead-chat", childSession: `app-lead-chat-${id}`, requestId: id, follow: null, parentId: "t-1", ...extra });
  const rows = [open("w-api", "API"), open("w-ui", "UI"), open("w-old", "Old", { state: "completed" }), open("w-cos", "Not this chat's", { ownerSession: "cos-chat" })];

  it("notes what still runs, once per task and once per brief, and never while the Lead works", () => {
    const blocks = [user("[MonoCode brief from Chief of Staff]", "app-cos-chat-b1"), said("All done: API and UI shipped.")];
    expect(stillRunningNote(lead({ blocks, busy: true }), rows)).toBeUndefined();
    const note = stillRunningNote(lead({ blocks }), rows, { id: "t-1", title: "Ship the API and UI" })!;
    expect(note).toMatchObject({
      role: "system",
      notice: "still-running",
      text: 'Still running: 2 (API, UI). "Ship the API and UI" stays open until they report back.',
      stillRunning: { taskIds: ["w-api", "w-ui"], briefId: "t-1" },
    });
    // Once it is there, the same claim again (or another one for the brief) adds nothing.
    const noted = lead({ blocks: [...blocks, note] });
    expect(stillRunningNote(noted, rows, { id: "t-1", title: "Ship" })).toBeUndefined();
    const again = lead({ blocks: [...blocks, note, user("Ash: and?"), said("Everything is done.")] });
    expect(stillRunningNote(again, rows, { id: "t-1", title: "Ship" })).toBeUndefined();
    // Without a brief (Ash talking to the Lead): once per task; a new task gets its own note.
    expect(stillRunningNote(again, rows)).toBeUndefined();
    const more = [...rows, open("w-docs", "Docs")];
    expect(stillRunningNote(again, more)?.text).toBe("Still running: 3 (API, UI, Docs). Their reports come back here when they finish.");
    // Nothing out, or a reply that says what still runs: no note.
    expect(stillRunningNote(lead({ blocks }), [rows[2], rows[3]])).toBeUndefined();
    expect(stillRunningNote(lead({ blocks: [blocks[0], said("API is done; UI is still running.")] }), rows)).toBeUndefined();
  });

  // D5: a "done" is checked against what the workers actually did, not trusted (workerStuck.ts unfinishedWorker).
  it("names a worker that failed or said it cannot finish, and the same note covers it once", () => {
    const blocks = [user("[MonoCode brief from Chief of Staff]", "app-cos-chat-b1"), said("All done: API and UI shipped.")];
    const at = 10_000 + 60 * 60_000;
    const failed = open("w-ui", "UI", { state: "failed", error: "The build broke.", settledAt: 10_000, delivery: "delivered" });
    const note = stillRunningNote(lead({ blocks }), [...rows, failed], undefined, at)!;
    expect(note.text).toBe(
      "Still running: 2 (API, UI). Not finished: 1 (UI — Failed: the build broke). The work is not done yet.",
    );
    expect(note.stillRunning?.taskIds).toEqual(["w-api", "w-ui"]);
    expect(stillRunningNote(lead({ blocks: [...blocks, note] }), [...rows, failed], undefined, at)).toBeUndefined();
    // A declared block reads under Not finished, never as still running; retried by the Lead, it is not held against it.
    const blocked = open("w-ui", "UI", { stallKind: "blocked", stallReason: "The staging deploy key is not on this machine", stalledAt: 10_000 });
    const onlyApi = [open("w-api", "API"), blocked];
    expect(stillRunningNote(lead({ blocks }), onlyApi, undefined, at)?.text).toBe(
      "Still running: 1 (API). Not finished: 1 (UI — Cannot finish: the staging deploy key is not on this machine). The work is not done yet.",
    );
    const retried = { ...blocked, log: [{ at: 10_000, by: "owner:lead-chat", event: "lead_redo" }] };
    expect(stillRunningNote(lead({ blocks }), [open("w-api", "API"), retried], undefined, at)?.text).toBe(
      "Still running: 1 (API). Their reports come back here when they finish.",
    );
    // On a brief it says the brief itself is not done.
    expect(stillRunningNote(lead({ blocks }), [...rows, failed], { id: "t-1", title: "Ship the API and UI" }, at)?.text).toBe(
      'Still running: 2 (API, UI). Not finished: 1 (UI — Failed: the build broke). "Ship the API and UI" is not done.',
    );
  });

  it("keeps the brief open: a Lead that says it's done waits for its workers before its report goes", () => {
    const brief = leadBrief();
    const api = rows[0];
    const blocks = [user(brief.brief!, brief.requestId), said("All done: API and UI shipped.")];
    expect(followStep(brief, { chat: lead({ blocks }), children: [brief, api], now: 0 })).toEqual({ kind: "wait", why: "workers" });
  });

  it("the note survives a save, so a restart never adds it again", () => {
    const note = stillRunningNote(lead({ blocks: [user("go"), said("Done.")] }), rows, { id: "t-1", title: "Ship" })!;
    const saved = sanitizeSessionForPersist(lead({ blocks: [user("go"), said("Done."), note] }));
    expect(saved.blocks.at(-1)).toMatchObject({ notice: "still-running", stillRunning: { taskIds: ["w-api", "w-ui"], briefId: "t-1" } });
  });
});

describe("the Lead's chat shows what is out while it talks", () => {
  it("reads \"2 working: API, UI\" and who is asking, oldest first", () => {
    const row = (id: string, title: string, state: Delegation["state"], createdAt: number) =>
      leadBrief({ id, title, state, createdAt, ownerSession: "lead-chat", follow: null });
    const rows = [row("b", "UI", "running", 2), row("a", "API", "running", 1), row("c", "Docs", "question", 3), row("d", "Old", "completed", 0)];
    expect(workingLine(workingOn("lead-chat", rows))).toBe("2 working: API, UI · 1 waiting: Docs");
    expect(workingLine(workingOn("other", rows))).toBeUndefined();
    const many = ["A", "B", "C", "D", "E"].map((title, index) => row(title, title, "running", index));
    expect(workingLine(workingOn("lead-chat", many))).toBe("5 working: A, B, C +2");
  });
});
