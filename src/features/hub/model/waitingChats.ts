// "Waiting on you": the chats whose agent asked Ash something (docs/HUB-PLAN.md: questions stay in the chat that owns
// the work; Today lists the chats waiting on him, each with its one-line question and the agent's recommended answer;
// one tap takes the pick). The app reports its chats here (`noteChats`) and lends the store its hands (`setWaitingChatsHost`):
// answer a live AskUserQuestion, send a message into a chat, open a chat.
//
// - Kept across restarts (local storage): an agent that asked and was cut off by a restart is still waiting. Its live
//   question died with the turn, so it is answered with a message into that chat instead.
// - A chat stops waiting the moment it moves on: answered in place, a new turn started, or the agent stopped asking.
// - A chat archived or deleted leaves with it (`forgetWaitingChat`, from the app's remove path); at launch the app
//   prunes any whose saved conversation is gone (`pruneWaitingChats`), since `noteChats` only sees open chats.
// - Hooks for the parallel packages: Autopilot reads the list and calls `takePick(id, { by: "autopilot" })` (red lines
//   refused); H4 routes a worker's question to the Lead that delegated it with `setWorkerQuestionRouter`.
import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { findMono, monoForSession } from "../../monos/model/mono";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import type { Block, HarnessId, Session } from "../../sessions/model/session";
import { sessionDisplayTitle } from "../../sessions/model/session";
import {
  chatQuestion,
  gateQuestion,
  pickMessage,
  pickReply,
  wordsMessage,
  wordsReply,
  type ChatQuestion,
  type GateKind,
} from "./chatQuestions";
import { hubData } from "./hubData";
import { leadFor } from "./hubLeads";
import { forYou } from "./userName";

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
  /** Why the gate let it through (D3): a choice, an approval, a red line or an errand only Ash can run. */
  gate?: { kind: GateKind; reason: string };
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
const GATE_LOG_KEY = "monocode:hub-gate-log";
const GATE_LOG_MAX = 100;

/** One gate decision, kept so a wrong call can be seen: what was asked, and why it was let through or held back. */
export type GateRecord = {
  at: number;
  sessionId: string;
  title: string;
  question: string;
  pick?: string;
  admit: boolean;
  kind?: GateKind;
  reason: string;
};

let entries: Record<string, WaitingEntry> | undefined;
let gateRecords: GateRecord[] | undefined;
/** Questions already written to the gate log this run; the app reports the same question on every streamed word. */
const gateLogged = new Set<string>();
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

/** The gate decisions so far, newest last. Kept across restarts so a wrong call can still be found afterwards. */
export function gateLog(): GateRecord[] {
  if (!gateRecords) {
    try {
      const raw = JSON.parse(localStorage.getItem(GATE_LOG_KEY) ?? "[]") as unknown;
      gateRecords = Array.isArray(raw) ? (raw as GateRecord[]) : [];
    } catch {
      gateRecords = [];
    }
  }
  return [...gateRecords];
}

function recordGate(chat: ChatInput, q: ChatQuestion, gate: ReturnType<typeof gateQuestion>, now: number): void {
  const key = `${chat.id}\u0000${q.question}\u0000${q.pick ?? ""}\u0000${gate.admit}`;
  if (gateLogged.has(key)) return;
  gateLogged.add(key);
  const next = [
    ...gateLog(),
    {
      at: now,
      sessionId: chat.id,
      title: sessionDisplayTitle(chat.title, chat.harness as HarnessId),
      question: q.question,
      ...(q.pick ? { pick: q.pick } : {}),
      admit: gate.admit,
      ...(gate.admit ? { kind: gate.kind } : {}),
      reason: gate.reason,
    },
  ].slice(-GATE_LOG_MAX);
  gateRecords = next;
  try {
    localStorage.setItem(GATE_LOG_KEY, JSON.stringify(next));
  } catch {
    /* without storage the log still works until the app restarts */
  }
}

const sameQuestion = (a: WaitingEntry, b: ChatQuestion) =>
  a.source === b.source && a.question === b.question && a.requestId === b.requestId && a.pick === b.pick && a.more === b.more && a.flag === b.flag;

/** The time of Ash's last real message in the chat, if the blocks say. */
function lastAshMessageAt(blocks: ChatInput["blocks"]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion) return b.startedAt;
  }
  return undefined;
}

// The app calls noteChats on every change to any chat (each streamed word): a chat whose transcript, turn and live
// question are the same objects as last time is not read again.
const reads = new WeakMap<object, { busy: boolean; pending: unknown; q: ChatQuestion | null }>();
function readChat(chat: ChatInput): ChatQuestion | null {
  const seen = reads.get(chat.blocks);
  if (seen && seen.busy === !!chat.busy && seen.pending === chat.pendingQuestion) return seen.q;
  const q = chatQuestion(chat);
  reads.set(chat.blocks, { busy: !!chat.busy, pending: chat.pendingQuestion, q });
  return q;
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
    const q = readChat(chat);
    if (q) {
      if (q.source === "ask") seenLive.add(liveKey(chat.id, q.requestId));
      // An entry stored before the gate existed has no decision yet: judge it again even when the question is unchanged.
      if (old && sameQuestion(old, q) && old.gate) continue;
      const gate = gateQuestion(q);
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
      // A worker's question is its Lead's, not Ash's, so the gate doesn't judge it. Everything else must be admitted.
      if (!entry.routedToLead) {
        recordGate(chat, q, gate, now);
        if (!gate.admit) {
          if (old) delete edit()[chat.id];
          continue;
        }
        entry.gate = { kind: gate.kind, reason: gate.reason };
      }
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

/** An entry stored before the gate existed is judged as it is now; a worker's question is never Ash's. */
function admitted(entry: WaitingEntry): boolean {
  if (entry.routedToLead) return false;
  return entry.gate ? true : gateQuestion(entry).admit;
}

/** The chats waiting on Ash, oldest question first; one project's when `projectId` is given. Workers routed to a Lead are not his. */
export function waitingChats(projectId?: string): WaitingChat[] {
  return Object.values(load())
    .filter(admitted)
    .map(describe)
    .filter((c) => !projectId || c.projectId === projectId)
    .sort((a, b) => a.askedAt - b.askedAt);
}

export function findWaitingChat(sessionId: string): WaitingChat | undefined {
  const e = load()[sessionId];
  return e && admitted(e) ? describe(e) : undefined;
}

function drop(sessionId: string): void {
  const prev = load();
  if (!(sessionId in prev)) return;
  const next = { ...prev };
  delete next[sessionId];
  save(next);
}

/** The chat was archived or deleted: it doesn't wait on Ash any more. */
export function forgetWaitingChat(sessionId: string): void {
  drop(sessionId);
}

/**
 * Take off every waiting chat whose saved conversation no longer exists (`exists` false). One that couldn't be looked
 * up (it throws) stays, to be checked next time.
 */
export async function pruneWaitingChats(exists: (sessionId: string) => Promise<boolean>): Promise<void> {
  for (const sessionId of Object.keys(load())) {
    const there = await exists(sessionId).catch(() => true);
    if (!there) drop(sessionId);
  }
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
  if (options.by === "autopilot" && (chat.redLine || chat.provide)) return { ok: false, reason: forYou("This one touches a red line, so it waits for Ash.") };
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

/** A red-line ask's two explicit choices (port map idea 3; no default, no "this session", no "always"). */
export type ApprovalChoice = "approve-once" | "deny";

/** What Ash's choice says in the chat. */
export function approvalMessage(choice: ApprovalChoice, q: Pick<ChatQuestion, "question" | "pick">): string {
  return choice === "approve-once"
    ? `Approved, this once: ${q.pick ?? q.question}`
    : `Denied: don't do this. (${q.question})`;
}

/**
 * Answer a red-line ask with one explicit choice. Refused when the ask changed since Ash saw it (matched to Alan's
 * Workspace hermes-view.js guard and renderer.js "Give back" refusal: a stale card never answers).
 */
export async function answerApproval(
  sessionId: string,
  choice: ApprovalChoice,
  seen: Pick<WaitingChat, "question" | "askedAt" | "pick">,
): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat) return { ok: false, reason: "That chat isn't waiting any more." };
  if (chat.question !== seen.question || chat.askedAt !== seen.askedAt || chat.pick !== seen.pick)
    return { ok: false, reason: "That changed while you were looking. Open the chat to see where it stands." };
  const text = approvalMessage(choice, chat);
  const prompt = host?.liveQuestion(sessionId);
  const reply = prompt && prompt.requestId === chat.requestId ? wordsReply(prompt, text) : undefined;
  return answer(chat, reply && { reply, words: text }, text);
}

/** "Open": jump into the chat. */
export function openWaitingChat(sessionId: string): void {
  const e = load()[sessionId];
  host?.open(sessionId, e ? describe(e).projectId : null);
}

/** Autopilot may answer this one by itself: the agent suggested an answer and it is not a red line. */
export function autopilotMayTake(chat: Pick<WaitingChat, "pick" | "redLine" | "provide">): boolean {
  // Something only Ash can hand over (a key, access) is never Autopilot's to answer (r65).
  return !!chat.pick && !chat.redLine && !chat.provide;
}

// ---- the same hands, for a stuck worker (H4: monos/model/stuckActions.ts) --------------------------------------------
// A worker's question is its Lead's first, so it isn't in this list; Ash can still answer it from the stuck card.

/** A chat's live AskUserQuestion, if this window has it. */
export function liveChatQuestion(sessionId: string): UserQuestionPrompt | undefined {
  return host?.liveQuestion(sessionId);
}

/** Answer a chat's live question in place; false when the app's hands aren't there or it moved on. */
export function respondInChat(sessionId: string, requestId: number, reply: UserQuestionReply): boolean {
  const prompt = host?.liveQuestion(sessionId);
  if (!host || prompt?.requestId !== requestId) return false;
  host.respond(sessionId, requestId, reply);
  return true;
}

/** Ash's words into a chat as his next message (mid-turn it steers or queues, as the composer does). */
export async function sendToChat(sessionId: string, text: string): Promise<boolean> {
  if (!host || !text.trim()) return false;
  return host.send(sessionId, text.trim()).catch(() => false);
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

/** Tests: forget the list, the gate log, and what is stored. */
export function resetWaitingChats(): void {
  entries = undefined;
  gateRecords = undefined;
  host = undefined;
  router = undefined;
  seenLive.clear();
  gateLogged.clear();
  version += 1;
}
