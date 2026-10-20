// The real-Claude test bench's driver (scripts/hub-realtest.mjs, docs/REALTEST.md). A dev copy started with a verify
// plan that names a driver folder (src-tauri/src/verify_live.rs: only a dev copy under a temporary HOME) takes Ash's
// scripted actions one at a time and does each through the same calls his typing and clicks use: a message into a
// project's leadership room (GroupChatView's send), a message to a Mono or a chat (the composer's onSubmit), the Stop
// button, opening a view. It also answers what the window shows (rooms, chats, the Monos rail, the open view) and keeps
// a timestamped log of room messages and chat state changes for the run's timings. Nothing here runs without a plan.

import { invoke } from "@tauri-apps/api/core";

import {
  exportChats,
  getChat,
  leadershipChatId,
  replyProblem,
  roomPaused,
  roomPick,
  sendMessage,
  simulateReplies,
  startConversation,
  typingIn,
} from "../../features/hub/model/hubChats";
import { answerInWords, findWaitingChat, takePick } from "../../features/hub/model/waitingChats";
import { listMonos, monoForSession, monoState } from "../../features/monos/model/mono";
import type { Session } from "../../features/sessions/model/session";
import { appIdentity } from "./appIdentity";

/**
 * Where Ash writes: a room, a Mono's chat, a chat by id, or a project's coding team (a new chat there, as his New
 * session makes one; a chat already in it with `session`).
 */
export type DriverTarget = { room: string } | { mono: string } | { session: string } | { codingTeam: string };

export type DriverAction = { id: string; op: string; error?: string; [key: string]: unknown };

/** What the driver needs from App.tsx (the same handlers Ash's composer, Stop button and rail use). */
export type DriverHost = {
  sessions(): Session[];
  /** Open a Mono's chat the way a click on the rail does; resolves with its session id once it is open. */
  openMono(monoId: string): Promise<string | null>;
  /** The composer's send (queues or steers when the chat is busy, like Ash's typing). */
  submit(sessionId: string, text: string): boolean;
  /** The Stop button. */
  stop(sessionId: string): Promise<unknown> | void;
  /** Leave any open Mono chat and show a hub view (Today, a project's Being built or room), as a click on it does. */
  showHub(selection: { project: string; item: string }): void;
  /** Hold every Claude chat (and new ones) to this model and effort. */
  setDefaults(model: string, effort: string): void;
  /** Open a chat the way a click on it does (a worker's sub-chat under its owner's Mono when `owner` is given). */
  openSession(sessionId: string, owner?: string): void;
  /** A new chat in a project's coding team (App.tsx startCodingTeamChat): its id, or null when it has no code folder. */
  startCodingTeamChat?(projectId: string): string | null;
};

export function driverEnabled(): boolean {
  const identity = appIdentity();
  return identity?.kind === "dev" && identity.verify?.driver === true;
}

const STORAGE_PREFIXES = ["monocode:hub-", "monocode:mono-roster", "monocode:mono-rail", "monocode.lastModel", "monocode.defaultModels", "monocode.lastModelSettings"];
const TEXT_MAX = 4000;

function clip(text: unknown, max = TEXT_MAX): string {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…[${value.length}]` : value;
}

/** The text of a chat's last assistant reply, as far as the block shape shows it. */
function lastAssistantText(session: Session): string {
  for (let i = session.blocks.length - 1; i >= 0; i -= 1) {
    const block = session.blocks[i] as unknown as Record<string, unknown>;
    if (block && (block.role === "assistant" || block.kind === "assistant" || block.type === "assistant")) {
      const text = block.text ?? block.content ?? block.markdown;
      if (typeof text === "string" && text.trim()) return clip(text, 600);
    }
  }
  return "";
}

function sessionRow(session: Session) {
  const mono = monoForSession(session.id);
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    worktree: session.worktreeCwd ?? null,
    harness: session.harness,
    model: session.model,
    effort: session.modelSettings?.effort ?? null,
    busy: !!session.busy,
    turnReady: !!session.turnReady,
    queued: session.queuedMessages?.length ?? 0,
    queueStatus: session.queueStatus ?? null,
    question: !!(session as { pendingQuestion?: unknown }).pendingQuestion,
    usageLimit: !!session.usageLimit,
    hidden: !!session.sidebarHidden,
    orchestrationLeadId: session.orchestrationLeadId ?? null,
    mono: mono?.id ?? null,
    monoState: mono ? monoState(session) : null,
    blocks: session.blocks.length,
    last: lastAssistantText(session),
  };
}

function roomRows() {
  return exportChats().map((chat) => ({
    id: chat.id,
    projectId: chat.projectId,
    name: chat.name,
    memberIds: chat.memberIds,
    typing: typingIn(chat.id) ?? null,
    pick: roomPick(chat.id) ?? null,
    replyError: chat.replyError ?? null,
    conversations: chat.conversations.map((conv) => ({
      id: conv.id,
      title: conv.title,
      when: conv.when,
      paused: roomPaused(chat.id, conv.id),
      problem: replyProblem(chat.id, conv.id) ?? null,
      messages: conv.messages.map((message) => ({ id: message.id, from: message.from, text: message.text, quiet: !!message.quiet, pick: message.pick ?? null })),
    })),
  }));
}

function storageRows(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = clip(localStorage.getItem(key), 20_000);
    }
  } catch {
    // no storage
  }
  return out;
}

/** What the window shows: every element the hub marks with a data-hub-* or data-mono-* attribute, and the main text. */
function domRows() {
  const marked = [...document.querySelectorAll<HTMLElement>("*")].filter((element) =>
    [...element.attributes].some((attr) => attr.name.startsWith("data-hub-") || attr.name.startsWith("data-mono-")),
  );
  const elements = marked.slice(0, 600).map((element) => ({
    tag: element.tagName.toLowerCase(),
    attrs: Object.fromEntries(
      [...element.attributes]
        .filter((attr) => attr.name.startsWith("data-") || attr.name === "aria-expanded" || attr.name === "aria-label" || attr.name === "role")
        .map((attr) => [attr.name, clip(attr.value, 200)]),
    ),
    text: clip(element.innerText?.trim() ?? "", 300),
    visible: element.getClientRects().length > 0,
  }));
  const main = document.querySelector("main") ?? document.body;
  return { elements, mainText: clip((main as HTMLElement).innerText ?? "", 12_000), bodyText: clip(document.body.innerText ?? "", 20_000) };
}

export function snapshot(host: DriverHost) {
  return {
    at: Date.now(),
    sessions: host.sessions().map(sessionRow),
    monos: listMonos().map((mono) => ({ id: mono.id, name: mono.name, sessionId: mono.sessionId ?? null, projects: mono.projects })),
    rooms: roomRows(),
    storage: storageRows(),
    dom: domRows(),
  };
}

/** Console errors and warnings, and uncaught errors, since the driver started (the run keeps them as evidence). */
const consoleLines: Array<Record<string, unknown>> = [];
function captureConsole(): void {
  const keep = (level: string, args: unknown[]) => {
    if (consoleLines.length > 2000) consoleLines.shift();
    consoleLines.push({
      t: Date.now(),
      kind: "console",
      level,
      text: clip(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "), 1200),
    });
  };
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      keep(level, args);
      original(...args);
    };
  }
  window.addEventListener("error", (event) => keep("uncaught", [event.message]));
  window.addEventListener("unhandledrejection", (event) => keep("unhandled", [event.reason]));
}

/** Timestamped changes the window saw: room messages as they land, typing, and each chat's busy and question state. */
export class DriverLog {
  private seen = new Set<string>();
  private typing = new Map<string, string | null>();
  private states = new Map<string, string>();
  private events: Array<Record<string, unknown>> = [];

  tick(host: DriverHost): void {
    const now = Date.now();
    for (const chat of exportChats()) {
      const typing = typingIn(chat.id) ?? null;
      if ((this.typing.get(chat.id) ?? null) !== typing) {
        this.typing.set(chat.id, typing);
        this.events.push({ t: now, kind: "room-typing", room: chat.id, who: typing });
      }
      for (const conv of chat.conversations)
        for (const message of conv.messages) {
          const key = `${chat.id}/${message.id}`;
          if (this.seen.has(key)) continue;
          this.seen.add(key);
          this.events.push({ t: now, kind: "room-message", room: chat.id, conv: conv.id, id: message.id, from: message.from, quiet: !!message.quiet, text: clip(message.text) });
        }
      if (chat.replyError && !this.seen.has(`${chat.id}/error/${chat.replyError}`)) {
        this.seen.add(`${chat.id}/error/${chat.replyError}`);
        this.events.push({ t: now, kind: "room-error", room: chat.id, error: chat.replyError });
      }
    }
    for (const session of host.sessions()) {
      const row = sessionRow(session);
      const state = JSON.stringify([row.busy, row.question, row.queued, row.usageLimit, row.monoState?.status ?? null, row.blocks]);
      if (this.states.get(session.id) === state) continue;
      const before = this.states.get(session.id);
      this.states.set(session.id, state);
      this.events.push({
        t: now,
        kind: before ? "session" : "session-new",
        session: session.id,
        mono: row.mono,
        title: row.title,
        busy: row.busy,
        question: row.question,
        queued: row.queued,
        usageLimit: row.usageLimit,
        monoStatus: row.monoState?.status ?? null,
        blocks: row.blocks,
        last: row.busy ? undefined : row.last,
      });
    }
  }

  drain(): Array<Record<string, unknown>> {
    const out = [...this.events, ...consoleLines.splice(0)];
    this.events = [];
    return out;
  }
}

/** A room id from what the scenario names: a project id (its leadership room) or a room id. */
export function roomId(name: string): string {
  return name.includes(":") ? name : leadershipChatId(name);
}

/** Ash's message into a room, exactly as GroupChatView's composer sends it (the newest conversation, or a new one). */
export function sendToRoom(name: string, text: string, fresh = false): { room: string; conversation: string } {
  const id = roomId(name);
  const chat = getChat(id);
  if (!chat) throw new Error(`no room ${id}`);
  const conv = fresh ? undefined : chat.conversations[0];
  if (!conv) {
    const created = startConversation(id, text);
    simulateReplies(id, created);
    return { room: id, conversation: created };
  }
  sendMessage(id, text, conv.id);
  simulateReplies(id, conv.id);
  return { room: id, conversation: conv.id };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function perform(action: DriverAction, host: DriverHost, log: DriverLog): Promise<unknown> {
  if (action.error) return { ok: false, error: action.error };
  switch (action.op) {
    case "ping":
      return { ok: true, at: Date.now() };
    case "defaults":
      host.setDefaults(String(action.model ?? "claude:sonnet-5"), String(action.effort ?? "medium"));
      return { ok: true };
    case "send": {
      const to = action.to as DriverTarget;
      const text = String(action.text ?? "");
      if (!text.trim()) throw new Error("send: empty text");
      if ("room" in to) return { ok: true, at: Date.now(), ...sendToRoom(to.room, text, action.fresh === true) };
      if ("codingTeam" in to) {
        const sessionId = host.startCodingTeamChat?.(to.codingTeam) ?? null;
        if (!sessionId) throw new Error(`send: no coding team for ${to.codingTeam}`);
        await wait(50);
        return { ok: host.submit(sessionId, text), at: Date.now(), session: sessionId, codingTeam: to.codingTeam };
      }
      const sessionId = "mono" in to ? await host.openMono(to.mono) : to.session;
      if (!sessionId) throw new Error(`send: no chat for ${JSON.stringify(to)}`);
      if ("session" in to && action.open !== false) host.openSession(sessionId, typeof action.owner === "string" ? action.owner : undefined);
      const accepted = host.submit(sessionId, text);
      return { ok: accepted, at: Date.now(), session: sessionId };
    }
    case "stop": {
      const sessionId = typeof action.session === "string" ? action.session : typeof action.mono === "string" ? (listMonos().find((m) => m.id === action.mono)?.sessionId ?? null) : null;
      if (!sessionId) throw new Error("stop: no chat");
      await host.stop(sessionId);
      return { ok: true, at: Date.now(), session: sessionId };
    }
    case "open": {
      if (typeof action.mono === "string") return { ok: true, session: await host.openMono(action.mono) };
      if (typeof action.session === "string") {
        host.openSession(action.session, typeof action.owner === "string" ? action.owner : undefined);
        return { ok: true };
      }
      const hub = action.hub as { project: string; item: string } | undefined;
      if (hub) {
        host.showHub(hub);
        await wait(Number(action.settleMs ?? 1500));
        return { ok: true, dom: domRows() };
      }
      throw new Error("open: nothing named");
    }
    case "answer": {
      // Today's Waiting on you row: "Take the pick" (one tap) or "answer in your words" + Send.
      const sessionId = typeof action.session === "string" ? action.session : typeof action.mono === "string" ? (listMonos().find((m) => m.id === action.mono)?.sessionId ?? null) : null;
      if (!sessionId) throw new Error("answer: no chat");
      const waiting = findWaitingChat(sessionId);
      if (!waiting) return { ok: false, error: "nothing waiting on Ash in that chat", session: sessionId };
      const result = typeof action.text === "string" && action.text.trim() ? await answerInWords(sessionId, action.text) : await takePick(sessionId);
      return { ok: true, at: Date.now(), session: sessionId, question: waiting.question ?? null, pick: waiting.pick ?? null, result };
    }
    case "snapshot":
      return { ok: true, ...snapshot(host) };
    case "drain":
      log.tick(host);
      return { ok: true, events: log.drain() };
    default:
      throw new Error(`unknown op ${action.op}`);
  }
}

/** The window's loop: take an action, do it, answer; tick the log in between. Returns a stop function. */
export function startDriver(host: DriverHost): () => void {
  let stopped = false;
  captureConsole();
  const log = new DriverLog();
  const loop = async () => {
    while (!stopped) {
      try {
        log.tick(host);
        const action = await invoke<DriverAction | null>("verify_live_take");
        if (action) {
          let result: unknown;
          try {
            result = await perform(action, host, log);
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          await invoke("verify_live_done", { id: String(action.id), result });
          continue;
        }
      } catch (error) {
        console.error("verify driver", error);
      }
      await wait(400);
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
