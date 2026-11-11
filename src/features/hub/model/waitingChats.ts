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
import { isCodingTeamChat } from "./codingTeam";
import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { findMono, monoForSession } from "../../monos/model/mono";
import { CUSTOM_OPTION_ID, type UserQuestionPrompt, type UserQuestionReply } from "../../sessions/model/userQuestion";
import { ASH_ANSWERED_PREFIX } from "../../monos/model/ashAnswersWorker";
import type { Block, HarnessId, QueuedMessage, Session } from "../../sessions/model/session";
import { sessionDisplayTitle } from "../../sessions/model/session";
import {
  askedBy,
  chatQuestion,
  gateQuestion,
  pickMessage,
  pickReply,
  plainOptionLabel,
  wordsMessage,
  wordsReply,
  type AskRow,
  type ChatQuestion,
  type GateKind,
  whoAsks,
} from "./chatQuestions";
import { hubData } from "./hubData";
import { asksHowThingsStand } from "./statusAsk";
import { leadFor } from "./hubLeads";
import { forUser, forYou } from "./userName";
import { questionVeto, UNREADABLE_REASON } from "../../autopilot/model/reviewerRules";

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
  /** r101 (6): rows of a live ask Ash hasn't answered yet, kept on his card until the Lead's next reply asks them again. */
  heldUntilReply?: boolean;
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
  /**
   * r99 (Critiquito 3): an app note into the chat (hidden, not a message from Ash): one row of a card answered. Falls
   * back to \`send\` when the host has no notes.
   */
  note?(sessionId: string, message: QueuedMessage): Promise<boolean>;
  /** r77: Allow or Deny the chat's held tool call (its permission card), in place. */
  decide?(sessionId: string, requestId: number, decision: "allow" | "deny"): void;
};

/** H4 (hub/questions-and-tree): return true when this chat is a worker and its question went to its Lead. */
export type WorkerQuestionRouter = (chat: WaitingEntry) => boolean;

type ChatInput = Pick<Session, "id" | "cwd" | "title" | "harness" | "busy" | "pendingQuestion" | "inboxAsk" | "ephemeral" | "orchestrationLeadId" | "queuedMessages"> & {
  blocks: readonly (Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion" | "startedAt"> & Partial<Pick<Block, "approval" | "tool" | "monoSpawnedSessions">>)[];
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
  /**
   * r80: what Ash actually answered, once he has: his own words when he typed them (they win over the agent's `pick`,
   * which is only its recommendation), the pick when he took it. Read this, never `pick`, for what was decided.
   */
  answer?: { words: string; by: "words" | "pick"; at: number };
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
      title: sessionDisplayTitle(chat.title, chat.harness as HarnessId, q.question),
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

/** Write Ash's answer onto the newest gate record of that question in that chat. */
function recordAnswer(sessionId: string, question: string, answer: NonNullable<GateRecord["answer"]>): void {
  const log = gateLog();
  const i = log.map((r) => r.sessionId === sessionId && r.question === question).lastIndexOf(true);
  if (i < 0) return;
  log[i] = { ...log[i], answer };
  gateRecords = log;
  try {
    localStorage.setItem(GATE_LOG_KEY, JSON.stringify(log));
  } catch {
    /* without storage the log still works until the app restarts */
  }
}

const sameQuestion = (a: WaitingEntry, b: ChatQuestion) =>
  (a.rows ?? []).map((r) => r.question).join("\u0000") === (b.rows ?? []).map((r) => r.question).join("\u0000") &&
  a.source === b.source && a.question === b.question && a.requestId === b.requestId && a.pick === b.pick && a.why === b.why && a.more === b.more && a.flag === b.flag &&
  (a.options ?? []).join("\u0000") === (b.options ?? []).join("\u0000");

/** The time of Ash's last real message in the chat, if the blocks say. */
function lastAshMessageAt(blocks: ChatInput["blocks"]): number | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion) return b.startedAt;
  }
  return undefined;
}

/**
 * r102 (B5 a0ba, 82ea: Ash asked "wat happened to the stuff i dumped earlier" with 5 decisions on his Inbox; the row
 * cleared the moment he sent it, so the Lead was told "his Inbox holds no asks from you" and the rail's Needs you went
 * too): asking how things stand answers nothing. A Lead's "Needs Ash" rows stay while every message Ash sent since they
 * were asked is a status question, through that turn and after its reply, until he answers or the Lead asks anew.
 */
function onlyAskedHowThingsStand(blocks: ChatInput["blocks"], since: number): boolean {
  let any = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role !== "user" || b.internal || b.monoSessionCompletion) continue;
    if ((b.startedAt ?? 0) <= since) break;
    if (!asksHowThingsStand(b.text ?? "")) return false;
    any = true;
  }
  return any;
}

/**
 * r81 (s14: the Lead wrote "Needs Ash:" and asked with buttons; Ash answered the buttons from Today and the card came
 * back from the "Needs Ash:" line, still "Needs you" three minutes later): a "Needs Ash:" line Ash already answered in
 * this turn (since his last own message) waits on nobody.
 */
function answeredThisTurn(chat: Pick<ChatInput, "id" | "blocks">, question: string): boolean {
  const since = lastAshMessageAt(chat.blocks) ?? 0;
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const asked = words(question);
  return gateLog().some((r) => {
    if (r.sessionId !== chat.id || !r.answer || r.answer.at < since) return false;
    const was = words(r.question);
    const shared = [...asked].filter((w) => was.has(w)).length;
    return shared / Math.max(asked.size, was.size, 1) >= 0.8;
  });
}

// The app calls noteChats on every change to any chat (each streamed word): a chat whose transcript, turn and live
// question are the same objects as last time is not read again.
const reads = new WeakMap<object, { busy: boolean; pending: unknown; queued: unknown; q: ChatQuestion | null }>();
function readChat(chat: ChatInput): ChatQuestion | null {
  const seen = reads.get(chat.blocks);
  if (seen && seen.busy === !!chat.busy && seen.pending === chat.pendingQuestion && seen.queued === chat.queuedMessages) return seen.q;
  const q = chatQuestion({ ...chat, plainQuestions: !!monoForSession(chat.id) });
  reads.set(chat.blocks, { busy: !!chat.busy, pending: chat.pendingQuestion, queued: chat.queuedMessages, q });
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
  noteBusy(chats);
  const prev = load();
  let next: Record<string, WaitingEntry> | undefined;
  const edit = () => (next ??= { ...prev });
  for (const chat of chats) {
    if (!counts(chat)) continue;
    const old = prev[chat.id];
    const read = readChat(chat);
    const mono = monoForSession(chat.id);
    const q =
      read?.source === "permission"
        ? { ...read, question: askedBy(read.question, whoAsks({ monoName: mono?.name, title: chat.title, project: chat.cwd, orchestrator: isCodingTeamChat(chat.id) || chat.blocks.some((b) => !!b.monoSpawnedSessions?.length) })) }
        : read?.source === "marker" && answeredThisTurn(chat, read.question)
          ? null
          : read;
    if (q) {
      if (q.source === "ask") seenLive.add(liveKey(chat.id, q.requestId));
      // An entry stored before the gate existed has no decision yet: judge it again even when the question is unchanged.
      if (old && sameQuestion(old, q) && old.gate) continue;
      const gate = gateQuestion(q);
      const entry: WaitingEntry = {
        ...q,
        sessionId: chat.id,
        cwd: chat.cwd,
        title: sessionDisplayTitle(chat.title, chat.harness as HarnessId, q.question),
        ...(mono ? { monoId: mono.id } : {}),
        askedAt: old && old.question === q.question ? old.askedAt : now,
      };
      // r103 (B5 e46f: "1 decision is waiting for you in the Inbox: overnight on Today" while the card showed only the
      // new "Apply the hub preview" ask): a status reply that asks something new doesn't answer what it asked before,
      // so the earlier rows stay on the same card beside the new ones.
      if (q.source === "marker" && old?.source === "marker" && !old.routedToLead && onlyAskedHowThingsStand(chat.blocks, old.askedAt)) {
        const rowsOf = (c: ChatQuestion): AskRow[] => c.rows ?? [{ question: c.question, options: c.options, pick: c.pick, redLine: !!c.redLine }];
        const fresh = rowsOf(q);
        const kept = rowsOf(old).filter((r) => !fresh.some((f) => f.question === r.question));
        if (kept.length) {
          const rows = [...kept, ...fresh];
          if (old.rows && old.rows.map((r) => r.question).join("\u0000") === rows.map((r) => r.question).join("\u0000")) continue;
          Object.assign(entry, { rows, more: rows.length - 1, askedAt: old.askedAt });
        }
      }
      // A held tool call only Ash can allow (r77): never a Lead's to answer.
      if (q.source !== "permission" && router?.(entry)) entry.routedToLead = true;
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
    // r101 (6): rows Ash hasn't answered stay while the Lead's turn runs on his partial answer.
    if (old.heldUntilReply && chat.busy) continue;
    const dead = old.source === "ask" && !seenLive.has(liveKey(chat.id, old.requestId));
    if ((old.source === "marker" || dead) && onlyAskedHowThingsStand(chat.blocks, old.askedAt)) {
      if (dead && old.requestId !== undefined) {
        const { requestId: _gone, ...rest } = old;
        edit()[chat.id] = rest;
      }
      continue;
    }
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
export function waitingChats(projectId?: string, { leadership = false }: { leadership?: boolean } = {}): WaitingChat[] {
  // r100 (c, B5 936c): a Mono over several projects (Chief of Staff) has no one project, so a project's Inbox dropped
  // its asks while the rail showed them. With `leadership`, a project's list carries those Monos' asks too.
  return Object.values(load())
    .filter(admitted)
    .map(describe)
    .filter((c) => !projectId || c.projectId === projectId || (leadership && c.projectId === null && !!c.monoId))
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
async function answer(
  chat: WaitingChat,
  live: { reply: UserQuestionReply; words: string } | undefined,
  message: string,
  given: { words: string; by: "words" | "pick" },
): Promise<TakeResult> {
  const h = host;
  if (!h) return { ok: false, reason: "The app isn't ready to answer yet. Open the chat instead." };
  const prompt = chat.requestId !== undefined ? h.liveQuestion(chat.sessionId) : undefined;
  if (prompt && prompt.requestId === chat.requestId && live) {
    h.respond(chat.sessionId, prompt.requestId, live.reply);
    drop(chat.sessionId);
    recordAnswer(chat.sessionId, chat.question, { ...given, at: Date.now() });
    return { ok: true, sent: live.words, chatName: chat.chatName };
  }
  const sent = await h.send(chat.sessionId, message).catch(() => false);
  if (!sent) return { ok: false, reason: `${chat.chatName} couldn't take a message right now. Open the chat to answer.` };
  drop(chat.sessionId);
  recordAnswer(chat.sessionId, chat.question, { ...given, at: Date.now() });
  return { ok: true, sent: message, chatName: chat.chatName };
}

/**
 * "Take the pick": answer with the agent's recommended answer. Autopilot calls this with `by: "autopilot"` and a Page
 * with `by: "page"`; both are refused on a red line, which always waits for Ash.
 */
export async function takePick(sessionId: string, options: { by?: "ash" | "autopilot" | "page" } = {}): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat) return { ok: false, reason: "That chat isn't waiting any more." };
  if (!chat.pick) return { ok: false, reason: "The agent didn't suggest an answer. Reply in your words or open the chat." };
  // A Page's tap is not Ash's either (PR #235 review): a red line waits for Ash whoever else asks.
  const notAsh = options.by === "autopilot" || options.by === "page";
  if (notAsh && (chat.redLine || chat.provide)) return { ok: false, reason: forYou("This one touches a red line, so it waits for Ash.") };
  // WP-101: the same rule a reviewed approval follows, on this door too. The pick is one answer, but the question
  // it answers can be the action ("Send it to Priya?"), and so can any option the card points back to.
  if (notAsh && chatQuestionVeto(chat))
    return { ok: false, reason: forYou("That one sends, deletes, moves money, publishes or changes access, so it waits for Ash.") };
  const prompt = host?.liveQuestion(sessionId);
  const reply = prompt && prompt.requestId === chat.requestId ? pickReply(prompt) : undefined;
  return answer(chat, reply && { reply, words: chat.pick }, pickMessage(chat), { words: chat.pick, by: "pick" });
}

/**
 * Every option a card points back to: its own, then each row's question and options. A list it can't read is `null`,
 * which the veto reads as a hold.
 */
function cardOptions(chat: Pick<ChatQuestion, "options" | "rows">): unknown[] | null {
  const collected: unknown[] = [];
  const take = (value: unknown): boolean => {
    if (value === undefined || value === null) return true;
    if (!Array.isArray(value)) return false;
    collected.push(...value);
    return true;
  };
  if (!take(chat.options)) return null;
  if (chat.rows === undefined || chat.rows === null) return collected;
  if (!Array.isArray(chat.rows)) return null;
  for (const row of chat.rows) {
    if (!row || typeof row !== "object") {
      collected.push(row);
      continue;
    }
    collected.push(row.question);
    if (!take(row.options)) return null;
  }
  return collected;
}

/**
 * Why autopilot won't answer this waiting question by itself, or null when it may (WP-101: the approval rule, here).
 * The chat is a saved shape read back from disk, so a field it can't read holds: `autopilotMayTake` runs while a list
 * draws, and a throw there would break the list rather than wait (WP-101 fix round 2, item F).
 */
export function chatQuestionVeto(chat: Pick<ChatQuestion, "question" | "pick" | "options" | "rows">): string | null {
  try {
    if (!chat || typeof chat !== "object") return UNREADABLE_REASON;
    const options = cardOptions(chat);
    if (!options) return UNREADABLE_REASON;
    return questionVeto({ question: chat.question, recommendation: chat.pick, options });
  } catch {
    return UNREADABLE_REASON;
  }
}

/** Ash's own words for the chat. */
export async function answerInWords(sessionId: string, text: string): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat) return { ok: false, reason: "That chat isn't waiting any more." };
  if (!text.trim()) return { ok: false, reason: "Type an answer first." };
  const prompt = host?.liveQuestion(sessionId);
  const reply = prompt && prompt.requestId === chat.requestId ? wordsReply(prompt, text) : undefined;
  return answer(chat, reply && { reply, words: text.trim() }, wordsMessage(chat, text), { words: text.trim(), by: "words" });
}

/** r99: a live question's rows answered so far from the card, by session and request, until every row has one. */
const partial = new Map<string, Record<string, string>>();

/** The rows of a waiting chat still open (a live question's rows already answered here are left out). */
export function openRows(chat: Pick<WaitingChat, "sessionId" | "requestId" | "rows">): AskRow[] {
  const given = partial.get(`${chat.sessionId}:${chat.requestId}`) ?? {};
  return (chat.rows ?? []).filter((row) => !(row.questionId && row.questionId in given));
}

/** The app note that answers one row of a "Needs Ash" card, so only that decision settles (answerSettles). */
export function rowAnswerNote(question: string, words: string): QueuedMessage {
  const flat = (t: string, max: number) => t.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, max);
  return {
    id: `ash-row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${ASH_ANSWERED_PREFIX} From the app: Ash answered your question "${flat(question, 300)}" from his Inbox: "${flat(words, 400)}". This settles that one only: no \`Needs Ash:\` line for it again; the others you asked him still wait on him. Act on it, and tell him in one line what happens next. This is an app notification, not a new message from Ash.`,
  };
}

/**
 * r99 (Critiquito 3): answer one decision of a card with several. A "Needs Ash" row goes as an app note, so the other
 * rows stay open on the Inbox and the rail; a live question's row is kept here until every row has an answer, then
 * the question is answered in place, all at once.
 */
/** What an unanswered row of a live ask returns when Ash answers another row first (r100 f). */
export const NOT_ANSWERED_YET =
  "Not answered yet: it stays on Ash's Inbox card. Don't guess or act on it; ask it again as a `Needs Ash:` line in your reply.";

export async function answerRow(sessionId: string, row: AskRow, words: string, by: "words" | "pick" = "words"): Promise<TakeResult> {
  const chat = findWaitingChat(sessionId);
  if (!chat?.rows?.some((r) => r.question === row.question)) return { ok: false, reason: "That chat isn't waiting any more." };
  const text = words.trim();
  if (!text) return { ok: false, reason: "Type an answer first." };
  const h = host;
  if (!h) return { ok: false, reason: "The app isn't ready to answer yet. Open the chat instead." };
  if (chat.source === "ask" && row.questionId) {
    const prompt = h.liveQuestion(sessionId);
    if (!prompt || prompt.requestId !== chat.requestId) return answer(chat, undefined, `About your question "${row.question}": ${text}`, { words: text, by });
    const key = `${sessionId}:${chat.requestId}`;
    const given = { ...(partial.get(key) ?? {}), [row.questionId]: text };
    partial.set(key, given);
    // r100 (f): each row's answer goes through at once. The open prompt takes it now; the rows Ash hasn't answered
    // go back as "not answered yet", so the lead asks them again as Needs Ash lines and they stay on his card.
    const reply: UserQuestionReply = { kind: "answered", answers: {}, custom: {} };
    for (const q of prompt.questions) {
      if (!(q.id in given)) {
        reply.answers[q.id] = [CUSTOM_OPTION_ID];
        reply.custom![q.id] = NOT_ANSWERED_YET;
        continue;
      }
      const option = q.options.find((o) => plainOptionLabel(o.label).toLowerCase() === given[q.id]!.toLowerCase());
      if (option) reply.answers[q.id] = [option.id];
      else {
        reply.answers[q.id] = [CUSTOM_OPTION_ID];
        reply.custom![q.id] = given[q.id]!;
      }
    }
    partial.delete(key);
    const done = await answer(chat, { reply, words: text }, text, { words: text, by });
    // r101 (6): the live question is gone once answered, and the Lead asks the other rows again only in its next
    // reply; until then they stay on his card, as plain asks (each answer goes as a note).
    const rest = (chat.rows ?? []).filter((r) => r.questionId && !(r.questionId in given)).map(({ questionId: _id, ...r }) => r);
    if (done.ok && rest.length) {
      const { projectId: _p, projectName: _n, chatName: _c, requestId: _r, ...entry } = chat;
      const last = rest[rest.length - 1]!;
      save({
        ...load(),
        [sessionId]: {
          ...entry,
          source: "marker",
          question: last.question,
          more: rest.length - 1,
          ...(rest.length > 1 ? { rows: rest } : { rows: undefined, options: last.options, pick: last.pick, redLine: last.redLine }),
          heldUntilReply: true,
        },
      });
    }
    return done;
  }
  const note = rowAnswerNote(row.question, text);
  const sent =
    (h.note ? await h.note(sessionId, note).catch(() => false) : false) ||
    (await h.send(sessionId, `About your question "${row.question}": ${text}`).catch(() => false));
  if (!sent) return { ok: false, reason: `${chat.chatName} couldn't take a message right now. Open the chat to answer.` };
  recordAnswer(sessionId, row.question, { words: text, by, at: Date.now() });
  // The card loses that row at once; the chat's next read agrees (answerSettles), and the rest stay open.
  const prev = load()[sessionId];
  if (prev?.rows) {
    const rest = prev.rows.filter((r) => r.question !== row.question);
    const next = { ...load() };
    if (rest.length > 1) next[sessionId] = { ...prev, rows: rest, more: rest.length - 1, ...(prev.question === row.question ? { question: rest[rest.length - 1]!.question } : {}) };
    else if (rest.length === 1) {
      const { rows: _rows, ...one } = prev;
      next[sessionId] = { ...one, question: rest[0]!.question, more: 0, ...(rest[0]!.options ? { options: rest[0]!.options } : { options: undefined }), pick: rest[0]!.pick, redLine: rest[0]!.redLine };
    } else delete next[sessionId];
    save(next);
  }
  return { ok: true, sent: text, chatName: chat.chatName };
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
  return answer(chat, reply && { reply, words: text }, text, { words: text, by: "words" });
}

/** r77: Allow or Deny a chat's held tool call from the card, when it is still the one held. */
export function answerPermission(sessionId: string, decision: "allow" | "deny"): TakeResult {
  const chat = findWaitingChat(sessionId);
  if (!chat || chat.source !== "permission" || chat.requestId === undefined) return { ok: false, reason: "That chat isn't waiting any more." };
  if (!host?.decide) return { ok: false, reason: "The app isn't ready to answer yet. Open the chat instead." };
  host.decide(sessionId, chat.requestId, decision);
  drop(sessionId);
  return { ok: true, sent: decision === "allow" ? "Allowed" : "Denied", chatName: chat.chatName };
}

/** "Open": jump into the chat. */
export function openWaitingChat(sessionId: string): void {
  const e = load()[sessionId];
  host?.open(sessionId, e ? describe(e).projectId : null);
}

/** Autopilot may answer this one by itself: the agent suggested an answer, it is not a red line, and it isn't a send,
 * a delete, a payment, a publish or an account change. A shape it can't read is never taken (WP-101 fix round 2, F). */
export function autopilotMayTake(chat: Pick<WaitingChat, "pick" | "redLine" | "provide" | "question" | "options" | "rows">): boolean {
  try {
    if (!chat || typeof chat !== "object") return false;
    // Something only Ash can hand over (a key, access) is never Autopilot's to answer (r65).
    return !!chat.pick && !chat.redLine && !chat.provide && !chatQuestionVeto(chat);
  } catch {
    return false;
  }
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

// r81 (c02 r80: Today said "all 5 are done" while the Lead was still checking two): which chats are mid-turn, kept
// apart from the waiting list so a turn starting or ending doesn't wake Autopilot.
let busyChats = new Set<string>();
let busyVersion = 0;
const busyListeners = new Set<() => void>();
function noteBusy(chats: readonly ChatInput[]): void {
  const next = new Set(busyChats);
  for (const chat of chats) chat.busy ? next.add(chat.id) : next.delete(chat.id);
  if (next.size === busyChats.size && [...next].every((id) => busyChats.has(id))) return;
  busyChats = next;
  busyVersion += 1;
  for (const listener of busyListeners) listener();
}

/** Whether a chat's turn is still running, as last noted (a Lead still checking what came back). */
export function chatBusy(sessionId: string): boolean {
  return busyChats.has(sessionId);
}

/** Re-render when a chat starts or ends a turn. */
export function useChatsBusyVersion(): number {
  return useSyncExternalStore(
    (listener) => (busyListeners.add(listener), () => void busyListeners.delete(listener)),
    () => busyVersion,
    () => busyVersion,
  );
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
