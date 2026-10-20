// Coding with a Lead (Ash, 20 Oct: "a good chat and delegate if needed as per the orchestrator stuff and still chat"):
// Ash's own messages never wait behind the app's deliveries, and a message he steers into the Lead's last turn never
// cuts the Lead's report to leadership short.
import { describe, expect, it } from "vitest";
import { canDispatchQueuedHead, canSteerQueuedHead, queuedHead } from "../../sessions/model/messageQueue";
import { newSession, type Block, type QueuedMessage, type Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";
import { FOLLOW_GRACE_MS, followStep, REPORT_REQUEST_PREFIX, reportRequestId } from "./followedBriefs";
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
