// "Waiting on you": the chats whose agent asked Ash something (docs/HUB-PLAN.md: questions stay in the chat that owns
// the work; Today lists the chats waiting on him, each with its one-line question and the agent's recommended answer;
// one tap takes the pick). The app reports its chats here (`noteChats`) and lends the store its hands (`setWaitingChatsHost`):
// answer a live AskUserQuestion, send a message into a chat, open a chat.
//
// - Kept across restarts (local storage): an agent that asked and was cut off by a restart is still waiting. Its live
//   question died with the turn, so it is answered with a message into that chat instead.
// - A chat stops waiting the moment it moves on: answered in place, a new turn started, or the agent stopped asking.
// - Hooks for the parallel packages: Autopilot reads the list and calls `takePick(id, { by: "autopilot" })` (red lines
//   refused); H4 routes a worker's question to the Lead that delegated it with `setWorkerQuestionRouter`.
import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { findMono, monoForSession } from "../../monos/model/mono";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import type { Block, HarnessId, Session } from "../../sessions/model/session";
import { sessionDisplayTitle } from "../../sessions/model/session";
import { chatQuestion, pickMessage, pickReply, wordsMessage, wordsReply, type ChatQuestion } from "./chatQuestions";
import { hubData } from "./hubData";
import { leadFor } from "./hubLeads";

/** One chat waiting on Ash, as stored. */
export type WaitingEntry = ChatQuestion & {
  sessionId: string;
  /** The chat's project folder and title when it asked, and its Mono if it is one. */
  cwd: string;
  title: string;
  monoId?: string;
  /** Epoch ms the question was first seen. */
  askedAt: number;
  /** A worker's question H4 handed to the Lead that delegated it: not Ash's. */
  routedToLead?: boolean;
};

/** A waiting chat as Today shows it. */
export type WaitingChat = WaitingEntry & {
  /** The hub project it belongs to, or null (a chat outside the strip's projects, or a Mono on several). */
  projectId: string | null;
  projectName: string | null;
  /** "EXO lead", or the chat's title. */
  chatName: string;
};

export type TakeResult = { ok: true; sent: string; chatName: string } | { ok: false; reason: string };

/** What the app lends the store. All optional pieces fail soft: nothing is answered on a guess. */
export type WaitingChatsHost = {
  /** The chat's live AskUserQuestion, if it is in memory and still asking. */
  liveQuestion(sessionId: string): UserQuestionPrompt | undefined;
  /** Answer that live question in place. */
  respond(sessionId: string, requestId: number, reply: UserQuestionReply): void;
  /** Send Ash's words into the chat as his next message (it opens the chat first if it isn't loaded). */
  send(sessionId: string, text: string): Promise<boolean>;
  /** Show the chat (its hub project, when it has one, so the hub can step aside for that project's coding view). */
  open(sessionId: string, projectId: string | null): void;
};

/** H4 (hub/questions-and-tree): return true when this chat is a worker and its question went to its Lead. */
export type WorkerQuestionRouter = (chat: WaitingEntry) => boolean;

type ChatInput = Pick<Session, "id" | "cwd" | "title" | "harness" | "busy" | "pendingQuestion" | "inboxAsk" | "ephemeral" | "orchestrationLeadId"> & {
  blocks: readonly Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion" | "startedAt">[];
};

const KEY = "monocode:hub-waiting-chats";

let entries: Record<string, WaitingEntry> | undefined;
let host: WaitingChatsHost | undefined;
let router: WorkerQuestionRouter | undefined;
let version = 0;
const listeners = new Set<() => void>();
/** Live questions seen in this run (a stored one from before a restart is not among them). */
const seenLive = new Set<string>();
const liveKey = (sessionId: string, requestId: number | undefined) => `${sessionId}#${requestId ?? ""}`;

function load(): Record<string, WaitingEntry> {
  if (entries) return entries;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    entries = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, WaitingEntry>) : {};
  } catch {
    entries = {};
  }
  return entries;
}

function save(next: Record<string, WaitingEntry>): void {
  entries = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* without storage the list still works until the app restarts */
  }
  version += 1;
  listeners.forEach((l) => l());
}

const sameQuestion = (a: WaitingEntry, b: ChatQuestion) =>
  a.source === b.source && a.question === b.question && a.requestId === b.requestId && a.pick === b.pick && a.more === b.more;

/** The time of Ash's last real message in the chat, if the blocks say. */
function lastAshMessageAt(blocks: ChatInput["blocks"]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion) return b.startedAt;
  }
  return undefined;
}

/** Inbox discussions, habit runs and orchestration workers have their own places; they never wait here. */
function counts(chat: ChatInput): boolean {
  return !chat.inboxAsk && !chat.ephemeral && !chat.orchestrationLeadId;
}

/**
 * The app's chats as they are now (call it whenever they change; chats not in the list are left as they were). A chat
 * with a question is added or updated; a chat that moved on is taken off. One exception: a live question whose turn
 * died (a restart) with nothing said since stays, to be answered with a message.
 */
export function noteChats(chats: readonly ChatInput[], now = Date.now()): void {
  const prev = load();
  let next: Record<string, WaitingEntry> | undefined;
  const edit = () => (next ??= { ...prev });
  for (const chat of chats) {
    if (!counts(chat)) continue;
    const old = prev[chat.id];
    const q = chatQuestion(chat);
    if (q) {
      if (q.source === "ask") seenLive.add(liveKey(chat.id, q.requestId));
      if (old && sameQuestion(old, q)) continue;
      const mono = monoForSession(chat.id);
      const entry: WaitingEntry = {
        ...q,
        sessionId: chat.id,
        cwd: chat.cwd,
        title: sessionDisplayTitle(chat.title, chat.harness as HarnessId),
        ...(mono ? { monoId: mono.id } : {}),
        askedAt: old && old.question === q.question ? old.askedAt : now,
      };
      if (router?.(entry)) entry.routedToLead = true;
      edit()[chat.id] = entry;
      continue;
    }
    if (!old) continue;
    // Seen asking in this run and now not: it was answered, skipped or stopped. Only a question from before a restart
    // (its turn died with it) still waits, as long as nothing was said and no turn runs since.
    const said = lastAshMessageAt(chat.blocks);
    const cutOff =
      old.source === "ask" && !seenLive.has(liveKey(chat.id, old.requestId)) && !chat.busy && !(said && said > old.askedAt);
    if (cutOff) {
      if (old.requestId === undefined) continue;
      const { requestId: _dead, ...rest } = old;
      edit()[chat.id] = rest;
    } else delete edit()[chat.id];
  }
  if (next) save(next);
}

function projectOf(entry: WaitingEntry): { id: string; name: string } | null {
  const projects = hubData().listProjects();
  const byId = (id: string | undefined) => projects.find((p) => p.id === id);
  const byFolder = (path: string | undefined) =>
    path ? projects.find((p) => p.folder && projectKey(p.folder) === projectKey(path)) : undefined;
  let hit = entry.monoId ? byId(leadFor(entry.monoId)?.projectId) : undefined;
  if (!hit && entry.monoId) {
    const mono = findMono(entry.monoId);
    const mine = (mono?.projects ?? []).map(byFolder).filter((p, i, all) => p && all.indexOf(p) === i);
    if (mine.length === 1) hit = mine[0];
  }
  if (!hit && !entry.monoId) hit = byFolder(entry.cwd);
  return hit ? { id: hit.id, name: hit.name } : null;
}

function describe(entry: WaitingEntry): WaitingChat {
  const project = projectOf(entry);
  const mono = entry.monoId ? findMono(entry.monoId) : undefined;
  return {
    ...entry,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    chatName: mono?.name ?? entry.title ?? "A chat",
  };
}

/** The chats waiting on Ash, oldest question first; one project's when `projectId` is given. Workers routed to a Lead are not his. */
export function waitingChats(projectId?: string): WaitingChat[] {
  return Object.values(load())
    .filter((e) => !e.routedToLead)
    .map(describe)
    .filter((c) => !projectId || c.projectId === projectId)
    .sort((a, b) => a.askedAt - b.askedAt);
}

export function findWaitingChat(sessionId: string): WaitingChat | undefined {
  const e = load()[sessionId];
  return e && !e.routedToLead ? describe(e) : undefined;
}

function drop(sessionId: string): void {
  const prev = load();
  if (!(sessionId in prev)) return;
  const next = { ...prev };
  delete next[sessionId];
  save(next);
}

/**
 * Answered from here: the live question in place when it is still the one asked (`live`, with the words it amounts to),
 * otherwise `message` into the chat.
 */
async function answer(chat: WaitingChat, live: { reply: UserQuestionReply; words: string } | undefined, message: string): Promise<TakeResult> {
  const h = host;
  if (!h) return { ok: false, reason: "The app isn't ready to answer yet. Open the chat instead." };
  const prompt = chat.requestId !== undefined ? h.liveQuestion(chat.sessionId) : undefined;
  if (prompt && prompt.requestId === chat.requestId && live) {
    h.respond(chat.sessionId, prompt.requestId, live.reply);
    drop(chat.sessionId);
    return { ok: true, sent: live.words, chatName: chat.chatName };
  }
  const sent = await h.send(chat.sessionId, message).catch(() => false);
  if (!sent) return { ok: false, reason: `${chat.chatName} couldn't take a message right now. Open the chat to answer.` };
  drop(chat.sessionId);
  return { ok: true, sent: message, chatName: chat.chatName };
}

/**
 * "Take the pick": answer with the agent's recommended answer. Autopilot calls this with `by: "autopilot"`; it is
 * refused on a red line, which always waits for Ash.
 */
export async function takePick(sessionId: string, options: { by?: "ash" | "autopilot" } = {}): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat) return { ok: false, reason: "That chat isn't waiting any more." };
  if (!chat.pick) return { ok: false, reason: "The agent didn't suggest an answer. Reply in your words or open the chat." };
  if (options.by === "autopilot" && chat.redLine) return { ok: false, reason: "This one touches a red line, so it waits for Ash." };
  const prompt = host?.liveQuestion(sessionId);
  const reply = prompt && prompt.requestId === chat.requestId ? pickReply(prompt) : undefined;
  return answer(chat, reply && { reply, words: chat.pick }, pickMessage(chat));
}

/** Ash's own words for the chat. */
export async function answerInWords(sessionId: string, text: string): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat) return { ok: false, reason: "That chat isn't waiting any more." };
  if (!text.trim()) return { ok: false, reason: "Type an answer first." };
  const prompt = host?.liveQuestion(sessionId);
  const reply = prompt && prompt.requestId === chat.requestId ? wordsReply(prompt, text) : undefined;
  return answer(chat, reply && { reply, words: text.trim() }, wordsMessage(chat, text));
}

/** "Open": jump into the chat. */
export function openWaitingChat(sessionId: string): void {
  const e = load()[sessionId];
  host?.open(sessionId, e ? describe(e).projectId : null);
}

/** Autopilot may answer this one by itself: the agent suggested an answer and it is not a red line. */
export function autopilotMayTake(chat: Pick<WaitingChat, "pick" | "redLine">): boolean {
  return !!chat.pick && !chat.redLine;
}

/** The app lends its hands; the returned function takes them back. */
export function setWaitingChatsHost(next: WaitingChatsHost): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

/** H4's seam: a worker's question goes to the Lead that delegated it. Until one is set, every question is Ash's. */
export function setWorkerQuestionRouter(next: WorkerQuestionRouter): () => void {
  router = next;
  return () => {
    if (router === next) router = undefined;
  };
}

/** Called whenever the list changes (Autopilot listens here). */
export function subscribeWaitingChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render when the list changes. */
export function useWaitingChatsVersion(): number {
  return useSyncExternalStore(subscribeWaitingChats, () => version, () => version);
}

/** Tests: forget the list (and what is stored). */
export function resetWaitingChats(): void {
  entries = undefined;
  host = undefined;
  router = undefined;
  seenLive.clear();
  version += 1;
}
