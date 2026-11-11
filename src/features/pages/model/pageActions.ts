// What a connected page may do (docs/pages-build-contract.md, "Connected pages"): answer an agent's question, take its
// pick, send a Mono a message, stop work, open a chat. Each goes through the path Ash's own tap takes for the same thing:
// - a chat waiting on him: Waiting on you's answerInWords / takePick / Open (hub/model/waitingChats.ts);
// - a worker asking its Lead: the answer in the worker's own chat (the app's question reply), as when Ash answers there;
// - an Ash OS question: Ash's answer call (`answer`, through hubData().answer);
// - a message: the composer's send into that Mono's chat (it steers or queues mid-turn, as typing would);
// - Stop: the delegation tree's own Stop for that work (and everything it handed out), or Stop on a Mono's chat;
// - Open: the tree's Open for handed-out work, the Mono's own view, or the waiting chat's Open.
// Nothing here is a new door: when the app hasn't lent a hand yet the page is told so, and nothing is guessed. What a
// page sends into a chat ends with "(sent from the <page> page)", and every action is logged for the page to show.
import { useSyncExternalStore } from "react";
import { fromPrompt, pickMessage, pickReply, wordsReply } from "../../hub/model/chatQuestions";
import { isPersonOnlyDecisionKey } from "../../hub/model/decisionKey";
import { hubData } from "../../hub/model/hubData";
import { needKeyOf } from "../../hub/model/localHub/decisions";
import type { HubAnswer } from "../../hub/model/types";
import { answerInWords, findWaitingChat, openWaitingChat, takePick, type TakeResult, type WaitingChat } from "../../hub/model/waitingChats";
import { delegationActions, delegationRows, type DelegationActions } from "../../monos/model/delegationStore";
import { isOpenDelegation, type Delegation } from "../../monos/model/delegations";
import { findMono, monoForSession, type Mono } from "../../monos/model/mono";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import type { PageAction } from "./pageSpec";
import { agentName } from "./pageData";
import { forUser } from "../../hub/model/userName";

/** The app's hands for a page's taps (App.tsx lends them; the same functions its own taps call). */
export type PageActionsHost = {
  /** The chat's live question, if it is in memory and still asking. */
  liveQuestion(sessionId: string): UserQuestionPrompt | undefined;
  /** Answer that live question in place (the app's question reply). */
  respond(sessionId: string, requestId: number, reply: UserQuestionReply): void;
  /** Send words into a chat as Ash's next message (it opens the chat first if it isn't loaded). */
  send(sessionId: string, text: string): Promise<boolean>;
  /** Show a chat (a Mono's in its own view). */
  open(sessionId: string): void;
  /** Show a Mono (made if it has no chat yet). */
  openMono(monoId: string): void;
};

let host: PageActionsHost | undefined;
/** The app's hands, when it has lent them (Change the hub sends a screen change to the MonoCode Hub lead with them). */
export function pageActionsHost(): PageActionsHost | undefined {
  return host;
}
export function setPageActionsHost(next: PageActionsHost): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

export type PageActionDeps = {
  host(): PageActionsHost | undefined;
  findWaiting(sessionId: string): WaitingChat | undefined;
  answerInWords(sessionId: string, text: string): Promise<TakeResult>;
  takePick(sessionId: string): Promise<TakeResult>;
  openWaiting(sessionId: string): void;
  answerNeed(needId: string, answer: HubAnswer): void;
  rows(): readonly Delegation[];
  delegationActions(): DelegationActions | undefined;
  findMono(id: string): Mono | undefined;
  monoForSession(sessionId: string): Mono | undefined;
};

export const appActionDeps: PageActionDeps = {
  host: () => host,
  findWaiting: findWaitingChat,
  answerInWords,
  takePick: (id) => takePick(id, { by: "page" }),
  openWaiting: openWaitingChat,
  answerNeed: (id, answer) => {
    const answer_ = hubData().answer;
    if (!answer_) throw new Error(forUser("Ash OS isn't connected, so its questions can't be answered from here."));
    answer_(id, answer);
  },
  rows: delegationRows,
  delegationActions,
  findMono,
  monoForSession,
};

export type ActionContext = { pageId: string; pageTitle: string };

/** "(sent from the Agents page)": what a page's words carry into a chat. */
export function fromPage(title: string): string {
  const t = title.trim() || "a";
  return `(sent from the ${/\bpage$/i.test(t) ? t : `${t} page`})`;
}
const signed = (text: string, ctx: ActionContext) => `${text.trim()}\n\n${fromPage(ctx.pageTitle)}`;

// ---- what pages did (shown under the page) ----------------------------------------------------------------------------
// r61 (PM's blind C3 on 0.16.2): a reply typed on a page went nowhere and the page said nothing. Every tap's outcome is
// logged now, a refusal or failure too (`ok: false`), and the app shows the newest one at the top of the page, with
// "Sending…" while it runs, whatever the page's own code does with the reply.
export type PageActionEntry = { at: number; line: string; ok?: false };
const LOG_MAX = 20;
const log = new Map<string, PageActionEntry[]>();
const inFlight = new Map<string, number>();
let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version++;
  listeners.forEach((l) => l());
}
function note(pageId: string, line: string, ok = true): void {
  log.set(pageId, [{ at: Date.now(), line, ...(ok ? {} : { ok: false as const }) }, ...(log.get(pageId) ?? [])].slice(0, LOG_MAX));
  bump();
}
/** A tap the page asked for didn't go through (refused, or it failed): said on the page in plain words. */
export function notePageActionFailure(pageId: string, reason: string): void {
  note(pageId, `Didn't go through: ${reason}`, false);
}
/** A tap is running for this page ("Sending…" on the page); call the returned function when it settles. */
export function beginPageAction(pageId: string): () => void {
  inFlight.set(pageId, (inFlight.get(pageId) ?? 0) + 1);
  bump();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (inFlight.get(pageId) ?? 1) - 1;
    if (n > 0) inFlight.set(pageId, n);
    else inFlight.delete(pageId);
    bump();
  };
}
/** Whether a tap is running for this page now. */
export function pageActionRunning(pageId: string): boolean {
  return (inFlight.get(pageId) ?? 0) > 0;
}
/** What this page did, newest first. */
export function pageActionLog(pageId: string): PageActionEntry[] {
  return log.get(pageId) ?? [];
}
export function usePageActionsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
export function resetPageActionsForTest(): void {
  log.clear();
  inFlight.clear();
  host = undefined;
}

// ---- the actions --------------------------------------------------------------------------------------------------------
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const quoteOf = (text: string) => `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;
const NOT_READY = "The app isn't ready for that yet. Open the chat instead.";

function rowById(id: string, d: PageActionDeps): Delegation | undefined {
  return d.rows().find((r) => r.id === id);
}
/** The newest row a chat works for. */
function rowForChat(chatId: string, d: PageActionDeps): Delegation | undefined {
  let found: Delegation | undefined;
  for (const r of d.rows()) if (r.childSession === chatId && (!found || r.createdAt > found.createdAt)) found = r;
  return found;
}
function chatName(chatId: string, d: PageActionDeps): string {
  const mono = d.monoForSession(chatId);
  if (mono) return agentName(mono);
  const w = d.findWaiting(chatId);
  if (w) return w.chatName;
  const r = rowForChat(chatId, d);
  return r?.title ? quoteOf(r.title) : "that chat";
}
// A Page answers as itself, never as the person (review 220-r6, HIGH-1). A key only the person answers (a delivery
// check, an irreversible step, a fresh-eyes review, a fan-out restart) is refused here with a plain reason, and
// decisions.rs refuses the `page:<id>` answer again if a spelling slips past this check.
const ONLY_YOU = "Only you can answer that one. Open Needs you to answer it.";
const ONLY_YOU_CHAT = "Only you can answer that one. Open the chat to answer it.";
function refusePersonOnly(needId: string, ctx: ActionContext): void {
  // A Page with no id has no name to answer under, and it is never the person (decisions.ts refuses it too).
  if (!ctx.pageId.trim()) throw new Error("This page has no id, so it can't answer. Open Needs you to answer it.");
  const key = needKeyOf(needId);
  if (key !== undefined && isPersonOnlyDecisionKey(key)) throw new Error(ONLY_YOU);
}
type RedLineAsk = Pick<WaitingChat, "redLine" | "provide"> & { rows?: ReadonlyArray<{ redLine?: boolean }> };
/** A red-line ask, or one asking for a key, waits for the person: a Page answers neither, in words or by its pick. */
function refuseRedLine(ask: RedLineAsk | null | undefined): void {
  if (ask && (ask.redLine || ask.provide || ask.rows?.some((r) => r.redLine))) throw new Error(ONLY_YOU_CHAT);
}

function took(result: TakeResult): void {
  if (!result.ok) throw new Error(result.reason);
}

async function answer(args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps): Promise<string> {
  const text = str(args.text);
  if (!text) throw new Error("Type an answer first.");
  const needId = str(args.needId);
  if (needId) {
    refusePersonOnly(needId, ctx);
    d.answerNeed(needId, { text, from: ctx.pageId });
    return `Answered ${quoteOf(text)}`;
  }
  const chatId = str(args.chatId);
  if (!chatId) throw new Error("Say which chat to answer (chatId).");
  const name = chatName(chatId, d);
  const waiting = d.findWaiting(chatId);
  if (waiting) {
    refuseRedLine(waiting);
    took(await d.answerInWords(chatId, signed(text, ctx)));
    return `Answered ${name}: ${quoteOf(text)}`;
  }
  const h = d.host();
  const prompt = h?.liveQuestion(chatId);
  if (!h || !prompt) throw new Error("That chat isn't asking anything now.");
  refuseRedLine(fromPrompt(prompt));
  const reply = wordsReply(prompt, signed(text, ctx));
  if (reply) h.respond(chatId, prompt.requestId, reply);
  else if (!(await h.send(chatId, signed(text, ctx)).catch(() => false))) throw new Error(`${name} couldn't take a message right now. Open the chat to answer.`);
  return `Answered ${name}: ${quoteOf(text)}`;
}

async function pick(args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps): Promise<string> {
  const needId = str(args.needId);
  if (needId) {
    refusePersonOnly(needId, ctx);
    d.answerNeed(needId, { quick: "agree", from: ctx.pageId });
    return "Took the suggested answer";
  }
  const chatId = str(args.chatId);
  if (!chatId) throw new Error("Say which chat's pick to take (chatId).");
  const name = chatName(chatId, d);
  const waiting = d.findWaiting(chatId);
  if (waiting) {
    refuseRedLine(waiting);
    // A "Needs Ash:" line is answered with a message, which can say where it came from; a live question takes the
    // option itself (Waiting on you's Take the pick).
    if (waiting.source === "marker" && waiting.pick) took(await d.answerInWords(chatId, signed(pickMessage(waiting), ctx)));
    else took(await d.takePick(chatId));
    return `Took ${name}'s pick`;
  }
  const h = d.host();
  const prompt = h?.liveQuestion(chatId);
  if (!h || !prompt) throw new Error("That chat isn't asking anything now.");
  refuseRedLine(fromPrompt(prompt));
  const reply = pickReply(prompt);
  if (!reply) throw new Error("The agent didn't suggest an answer. Answer in your words or open the chat.");
  h.respond(chatId, prompt.requestId, reply);
  return `Took ${name}'s pick`;
}

async function message(args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps): Promise<string> {
  const text = str(args.text);
  if (!text) throw new Error("Type a message first.");
  const agentId = str(args.agentId);
  const mono = agentId ? d.findMono(agentId) : undefined;
  if (agentId && !mono) throw new Error("That agent isn't on your Monos list.");
  const chatId = mono ? mono.sessionId : str(args.chatId);
  if (mono && !chatId) throw new Error(`${agentName(mono)} has no chat yet. Open it once first.`);
  if (!chatId) throw new Error("Say who to message (agentId or chatId).");
  const h = d.host();
  if (!h) throw new Error(NOT_READY);
  const name = mono ? agentName(mono) : chatName(chatId, d);
  if (!(await h.send(chatId, signed(text, ctx)).catch(() => false))) throw new Error(`${name} couldn't take a message right now. Open the chat instead.`);
  return `Sent ${name}: ${quoteOf(text)}`;
}

async function stop(args: Record<string, unknown>, d: PageActionDeps): Promise<string> {
  const acts = d.delegationActions();
  const workerId = str(args.workerId);
  const agentId = str(args.agentId);
  const chatId = str(args.chatId);
  const row = workerId ? rowById(workerId, d) : chatId ? rowForChat(chatId, d) : undefined;
  if (workerId && !row) throw new Error("That work isn't listed any more.");
  if (row) {
    if (!isOpenDelegation(row)) throw new Error("That work already finished.");
    if (!acts) throw new Error("The app isn't ready to stop work yet.");
    const result = await acts.stopRow(row);
    if (result.stopFailed.length) throw new Error("Some of it wouldn't stop. Open the chat to stop it there.");
    return `Stopped ${quoteOf(row.title?.trim() || "Delegated work")}`;
  }
  const mono = agentId ? d.findMono(agentId) : chatId ? d.monoForSession(chatId) : undefined;
  const chat = mono?.sessionId ?? chatId;
  if (!chat) throw new Error(mono ? `${agentName(mono)} has no chat to stop.` : "Say what to stop (workerId, agentId or chatId).");
  if (!acts) throw new Error("The app isn't ready to stop work yet.");
  const result = await acts.stopTree(chat);
  if (result.stopFailed.length) throw new Error("Some of its work wouldn't stop. Open the chat to stop it there.");
  return `Stopped ${mono ? agentName(mono) : chatName(chat, d)}`;
}

/** mono.run (C4): ask one Mono to run work, as a message into its chat (it steers or queues, as typing would). */
async function run(args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps): Promise<string> {
  const text = str(args.text) || str(args.task);
  if (!text) throw new Error("Say what to run first.");
  if (!str(args.agentId)) throw new Error("Say which Mono should run it (agentId).");
  return (await message({ agentId: args.agentId, text }, ctx, d)).replace(/^Sent (.*?): “/, "Asked $1 to run: “");
}

/** tasks.write (C4): answer a task that asks, stop one, or hand a new one to a Mono. Each is the tap's own path. */
async function writeTask(args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps): Promise<string> {
  const op = str(args.op);
  if (op === "answer") return answer(args, ctx, d);
  if (op === "stop") return stop(args, d);
  if (op === "add") return run(args, ctx, d);
  throw new Error("A page can answer, stop or add a task (op: answer, stop or add).");
}

function open(args: Record<string, unknown>, d: PageActionDeps): string {
  const workerId = str(args.workerId);
  const agentId = str(args.agentId);
  const chatId = str(args.chatId);
  const row = workerId ? rowById(workerId, d) : chatId && !d.findWaiting(chatId) && !d.monoForSession(chatId) ? rowForChat(chatId, d) : undefined;
  if (row) {
    const acts = d.delegationActions();
    if (!acts) throw new Error("The app isn't ready to open that yet.");
    acts.openChild(row.ownerSession, row.childSession);
    return `Opened ${quoteOf(row.title?.trim() || "Delegated work")}`;
  }
  if (workerId) throw new Error("That work isn't listed any more.");
  if (agentId) {
    const mono = d.findMono(agentId);
    if (!mono) throw new Error("That agent isn't on your Monos list.");
    const h = d.host();
    if (!h) throw new Error("The app isn't ready to open that yet.");
    h.openMono(agentId);
    return `Opened ${agentName(mono)}`;
  }
  if (!chatId) throw new Error("Say what to open (workerId, agentId or chatId).");
  if (d.findWaiting(chatId)) {
    d.openWaiting(chatId);
    return `Opened ${chatName(chatId, d)}`;
  }
  const h = d.host();
  if (!h) throw new Error("The app isn't ready to open that yet.");
  h.open(chatId);
  return `Opened ${chatName(chatId, d)}`;
}

/**
 * Run one of a page's taps (the bridge has already checked Ash allowed it and that he tapped). Resolves to `{done}`, a
 * plain line of what happened; throws the plain reason when it couldn't be done.
 */
export async function runPageAction(call: PageAction | string, args: Record<string, unknown>, ctx: ActionContext, d: PageActionDeps = appActionDeps): Promise<{ done: string }> {
  let done: string;
  switch (call) {
    case "agents.answer":
      done = await answer(args, ctx, d);
      break;
    case "agents.pick":
      done = await pick(args, ctx, d);
      break;
    case "agents.message":
      done = await message(args, ctx, d);
      break;
    case "agents.stop":
      done = await stop(args, d);
      break;
    case "mono.run":
      done = await run(args, ctx, d);
      break;
    case "tasks.write":
      done = await writeTask(args, ctx, d);
      break;
    case "chats.open":
      // Opening is a tap too, but it changes nothing: not logged.
      return { done: open(args, d) };
    default:
      throw new Error(`“${call}” isn't something a page can do.`);
  }
  note(ctx.pageId, done);
  return { done: done.replace(/: “.*”$/, "") };
}
