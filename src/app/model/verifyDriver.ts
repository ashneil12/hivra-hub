// The real-Claude test bench's driver (scripts/hub-realtest.mjs, docs/REALTEST.md). A dev copy started with a verify
// plan that names a driver folder (src-tauri/src/verify_live.rs: only a dev copy under a temporary HOME) takes Ash's
// scripted actions one at a time and does each through the same calls his typing and clicks use: a message into a
// project's leadership room (GroupChatView's send), a message to a Mono or a chat (the composer's onSubmit), the Stop
// button, opening a view. It also answers what the window shows (rooms, chats, the Monos rail, the open view) and keeps
// a timestamped log of room messages and chat state changes for the run's timings, and can reload the window the way a
// vite full reload does. Nothing here runs without a plan.

import { invoke } from "@tauri-apps/api/core";

import {
  exportChats,
  getChat,
  leadershipChatId,
  replyProblem,
  roomDrafts,
  roomPaused,
  roomPick,
  sendMessage,
  simulateReplies,
  startConversation,
  typingIn,
} from "../../features/hub/model/hubChats";
import { answerInWords, answerRow, findWaitingChat, openRows, takePick } from "../../features/hub/model/waitingChats";
import { listMonos, monoForSession, monoState, removeMono, updateMono } from "../../features/monos/model/mono";
import { codingTeamChatProject } from "../../features/hub/model/codingTeam";
import { openCodingTeam, openMonoTeam } from "../../features/hub/model/hubNav";
import { openSubChats } from "../../features/monos/model/subChats";
import { monoFailure, retryMonoFailure } from "../../features/monos/model/monoFailures";
import { customModelEfforts, importCustomModels, listCustomModels } from "../../features/sessions/model/customModels";
import type { RuntimeMode, Session } from "../../features/sessions/model/session";
import { appIdentity } from "./appIdentity";
import { isRunningWork } from "../../features/sessions/model/inFlight";
import { armBenchQuit } from "./appLifecycle";
import { benchAshTeam } from "./benchAshTeam";
import { teamPack } from "../../features/hub/model/teamPack";
import { setUserName, userName } from "../../features/hub/model/userName";

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
  startCodingTeamChat?(projectId: string, runtimeMode?: RuntimeMode): string | null;
  /** Hold a chat's next turns to a runtime mode (a bench scene's own; a verify dev copy only). */
  setRuntimeMode?(sessionId: string, runtimeMode: RuntimeMode): void;
  /** Ash's Allow or Deny on one permission card (the bench's `approve` step; a verify dev copy only). */
  approve?(sessionId: string, requestId: number, decision?: "allow" | "deny"): void;
  /**
   * The sidebar's Archive on one chat (App.tsx onRemoveHistorySession in archive mode, no confirm): the run's own
   * teardown (`cleanup`). Never the Reset chat path.
   */
  archive?(sessionId: string): Promise<boolean>;
};

/** What `cleanup` did with the ids a run gave it: nothing outside those ids is touched. */
export type CleanupResult = {
  ok: boolean;
  archived: string[];
  removedMonos: string[];
  missing: string[];
  failed: { id: string; error: string }[];
};

function idList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
}

/**
 * A run's teardown (scripts/hub-verify-live.mjs): archives exactly the chats it names, through the sidebar's Archive,
 * and removes exactly the Monos it names, as the rail's Remove does. A Mono the roster doesn't have is reported as
 * missing; nothing else is looked at.
 */
export async function cleanup(action: DriverAction, host: DriverHost): Promise<CleanupResult> {
  const result: CleanupResult = { ok: true, archived: [], removedMonos: [], missing: [], failed: [] };
  // The Monos first, as the rail's Remove (hub repair then leaves a removed Lead gone), then the chats.
  const roster = new Set(listMonos().map((mono) => mono.id));
  for (const id of idList(action.monos)) {
    if (!roster.has(id)) {
      result.missing.push(id);
      continue;
    }
    try {
      removeMono(id);
      result.removedMonos.push(id);
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const id of idList(action.sessions)) {
    if (!host.archive) {
      result.failed.push({ id, error: "this window can't archive" });
      continue;
    }
    try {
      if (await host.archive(id)) result.archived.push(id);
      else result.failed.push({ id, error: "archive refused" });
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.ok = result.failed.length === 0;
  return result;
}

/** Runtime modes a bench send may start a chat in. Anything else keeps the app's default. */
const BENCH_MODES: readonly RuntimeMode[] = ["supervised", "auto-accept-edits", "auto", "full-access"];

/** The mode a bench action names, or undefined for one it doesn't know (the app's own default then). */
function benchMode(value: unknown): RuntimeMode | undefined {
  return BENCH_MODES.find((mode) => mode === value);
}

/** The permission cards a chat is waiting on Ash for: undecided approval blocks, oldest first. */
export function pendingApprovals(session: Session | undefined): number[] {
  return pendingPermissionAsks(session).map((ask) => ask.requestId);
}

/** One undecided permission card, with the tool and the paths the provider said it would touch. */
export type PermissionAsk = {
  requestId: number;
  tool: string;
  paths: string[];
  command?: string;
};

/** What each open permission card would do, so the bench can allow or refuse it. Oldest first. */
export function pendingPermissionAsks(session: Session | undefined): PermissionAsk[] {
  return (session?.blocks ?? [])
    .filter((block) => block.approval && !block.approval.decided)
    .map((block) => {
      const call = block.approval?.call;
      const command = call?.command ?? block.tool?.command;
      return {
        requestId: block.approval!.requestId,
        tool: call?.tool ?? block.tool?.title ?? "",
        paths: call?.paths ?? block.tool?.paths ?? [],
        ...(command ? { command } : {}),
      };
    });
}

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
    // A live AskUserQuestion card, or a written ask the chat is in "Waiting on you" for (r75: the bench missed a
    // "Needs the user:" ask worded over two lines).
    question: !!(session as { pendingQuestion?: unknown }).pendingQuestion || !!findWaitingChat(session.id),
    usageLimit: !!session.usageLimit,
    // Held on a permission card Ash hasn't decided (S14's stuck case), and what each card would touch.
    approvals: pendingApprovals(session).length,
    permissionAsks: pendingPermissionAsks(session),
    hidden: !!session.sidebarHidden,
    orchestrationLeadId: session.orchestrationLeadId ?? null,
    mono: mono?.id ?? null,
    monoState: mono ? monoState(session) : null,
    // A chat in a project's coding team (an orchestrator like the Lead): its project.
    codingTeam: codingTeamChatProject(session.id) ?? null,
    blocks: session.blocks.length,
    last: lastAssistantText(session),
    // The last few blocks as the chat shows them (a reply after a cut turn's note, a failure notice).
    tail: session.blocks.slice(-6).map((block) => ({
      role: block.role,
      ...(block.notice ? { notice: block.notice } : {}),
      ...(block.internal ? { internal: true } : {}),
      text: clip(block.text ?? "", 240),
    })),
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

/** What marks an element worth reporting: the hub's and the Monos' own, a brief's line, a team's pinned owner and sub-chats. */
const DOM_MARKS = ["data-hub-", "data-mono-", "data-briefed-", "data-coding-team-", "data-team-", "data-sub-chat"];

/**
 * What the window shows: every element the hub marks (DOM_MARKS: data-hub-*, data-mono-*, a brief's line, a team's list),
 * and the main text.
 */
export function domRows() {
  const marked = [...document.querySelectorAll<HTMLElement>("*")].filter((element) =>
    [...element.attributes].some((attr) => DOM_MARKS.some((mark) => attr.name.startsWith(mark))),
  );
  const elements = marked.slice(0, 600).map((element) => ({
    tag: element.tagName.toLowerCase(),
    attrs: Object.fromEntries(
      [...element.attributes]
        .filter((attr) => attr.name.startsWith("data-") || attr.name === "aria-expanded" || attr.name === "aria-checked" || attr.name === "aria-label" || attr.name === "role")
        .map((attr) => [attr.name, clip(attr.value, 200)]),
    ),
    text: clip(element.innerText?.trim() ?? "", 300),
    visible: element.getClientRects().length > 0,
  }));
  const main = document.querySelector("main") ?? document.body;
  return { elements, mainText: clip((main as HTMLElement).innerText ?? "", 12_000), bodyText: clip(document.body.innerText ?? "", 20_000) };
}

/**
 * What the bench never clicks for Ash: anything that deletes or resets (ash-day step 16), and anything that opens the
 * microphone (Dictate, and Continue on its explanation). Ash does those himself.
 */
export const NEVER_CLICK = /\b(delete|remove|forget|erase|uninstall|reset|wipe|sign out|log out|dictate|continue)\b/i;
const BUTTONS = 'button, [role="button"], [role="menuitem"]';

function shown(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function buttonLabel(element: HTMLElement): string {
  return clip((element.getAttribute("aria-label") || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(), 80);
}

/** The buttons Ash can see in the open screen (the main pane and any dialog), newest last, the way he reads them. */
/**
 * Where Ash's buttons are: the app, its dialogs, and the change bar's own root (main.tsx, data-change-bar: Now | Preview,
 * Apply, Discard, a page's See it and a drafted Mono's card), which sits outside <main> (run 24bf: AD14/AD15's bench saw
 * "no Now, no Preview, no Apply" while the change was offered).
 */
function buttonRoots(): Element[] {
  return [
    document.querySelector("main") ?? document.body,
    ...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-change-bar]'),
  ];
}

export function visibleButtons(): { label: string; disabled: boolean }[] {
  const roots = buttonRoots();
  const seen = new Set<Element>();
  const out: { label: string; disabled: boolean }[] = [];
  for (const root of roots)
    for (const element of root.querySelectorAll<HTMLElement>(BUTTONS)) {
      if (seen.has(element) || !shown(element)) continue;
      seen.add(element);
      const label = buttonLabel(element);
      if (label) out.push({ label, disabled: element.matches(":disabled, [aria-disabled='true']") });
    }
  return out.slice(-120);
}

/** Ash's click on a button by its label (the newest one when several match). Never a delete or reset. */
export function clickButton(label: string): { ok: boolean; error?: string; clicked?: string } {
  const want = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (!want) return { ok: false, error: "click: no label" };
  if (NEVER_CLICK.test(want)) return { ok: false, error: "the bench never clicks a delete or reset; Ash does that himself" };
  const roots = buttonRoots();
  const matches = roots
    .flatMap((root) => [...root.querySelectorAll<HTMLElement>(BUTTONS)])
    .filter((element) => shown(element) && !element.matches(":disabled, [aria-disabled='true']") && buttonLabel(element).toLowerCase() === want);
  const target = matches[matches.length - 1];
  if (!target) return { ok: false, error: `no button "${label}" on screen` };
  target.click();
  return { ok: true, clicked: buttonLabel(target) };
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

/**
 * Timestamped changes the window saw: room messages as they land (and as they first show while written), typing, and
 * each chat's busy and question state.
 */
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
      // A turn's words first showing in the room as it writes them (the live message), once per message.
      for (const draft of roomDrafts(chat.id)) {
        const key = `${chat.id}/draft/${draft.id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.events.push({ t: now, kind: "room-draft", room: chat.id, conv: draft.convId, id: draft.id, from: draft.monoId, text: clip(draft.text) });
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
    case "customModel": {
      // One of Ash's custom models for a run on it (scripts/hub-realconv.mjs --agents custom:<id>): metadata only,
      // through the same import a setup file uses. A key never comes this way: the router reads the one Ash saved in
      // the dev copies' Keychain item for this model id.
      const model = action.model as Record<string, unknown> | undefined;
      if (!model || typeof model !== "object") throw new Error("customModel: no model");
      if (Object.keys(model).some((field) => /key|token|secret|password/i.test(field)))
        return { ok: false, error: "customModel: the driver never takes a key; Ash saves it in the app" };
      const skipped: string[] = [];
      const added = importCustomModels([model], (reason) => skipped.push(reason));
      const id = typeof model.id === "string" ? model.id : "";
      const saved = listCustomModels().find((m) => m.id === id);
      return { ok: !!saved, added, skipped, model: saved ? { id: saved.id, name: saved.name, provider: saved.provider, modelId: saved.modelId, efforts: customModelEfforts(saved.reasoningEfforts) } : null };
    }
    case "teamPack": {
      // A bench run puts the starter Monos on the fresh dev copy and seats them in this project's leadership room
      // (benchAshTeam). A real fresh copy still offers them unticked. Only "ash", and only for one project.
      if (action.pack !== "ash") return { ok: false, error: 'teamPack: only "ash" (the pre-load)' };
      const project = typeof action.project === "string" ? action.project.trim() : "";
      if (!project) return { ok: false, error: "teamPack: no project" };
      // A hub project's id is not its folder: the room takes the id, and the Monos work on the folder a kickoff names.
      const folder = typeof action.folder === "string" ? action.folder.trim() : "";
      const { monos, wrote } = await benchAshTeam(folder ? { project, folder } : { project });
      return { ok: teamPack() === "ash" && monos.length > 0, pack: teamPack(), wrote, monos };
    }
    case "userName": {
      // r91: the bench names the owner as his own app does (onboarding's "What should your team call you?").
      if (typeof action.name !== "string" || !action.name.trim()) return { ok: false, error: "userName: no name" };
      setUserName(action.name);
      return { ok: userName() === action.name.trim(), name: userName() };
    }
    case "monoSetting": {
      // A bench scene's per-Mono setting before it starts (scripts/realconv: scene.longChat). Only "Keep one long chat".
      const mono = listMonos().find((m) => m.id === action.mono);
      if (!mono) throw new Error(`monoSetting: no Mono ${String(action.mono)}`);
      const on = action.longChat === true;
      updateMono(mono.id, ({ longChat: _, ...rest }) => (on ? { ...rest, longChat: true } : rest));
      return { ok: true, mono: mono.id, longChat: on };
    }
    case "defaults":
      host.setDefaults(String(action.model ?? "claude:sonnet-5"), String(action.effort ?? "medium"));
      return { ok: true };
    case "send": {
      const to = action.to as DriverTarget;
      const text = String(action.text ?? "");
      if (!text.trim()) throw new Error("send: empty text");
      if ("room" in to) return { ok: true, at: Date.now(), ...sendToRoom(to.room, text, action.fresh === true) };
      if ("codingTeam" in to) {
        // A bench scene may start its chat in Full access (a coding-team scene that must run tools without a card).
        const mode = benchMode(action.runtimeMode);
        const sessionId = host.startCodingTeamChat?.(to.codingTeam, mode) ?? null;
        if (!sessionId) throw new Error(`send: no coding team for ${to.codingTeam}`);
        await wait(50);
        return { ok: host.submit(sessionId, text), at: Date.now(), session: sessionId, codingTeam: to.codingTeam, ...(mode ? { runtimeMode: mode } : {}) };
      }
      const sessionId = "mono" in to ? await host.openMono(to.mono) : to.session;
      if (!sessionId) throw new Error(`send: no chat for ${JSON.stringify(to)}`);
      // A Mono-chat scene's mode (scripts/realconv/player.mjs scene.runtimeMode) takes the same path as a coding
      // team's: set on that Mono's chat before Ash's line goes in, and its earlier mode handed back so the scene
      // can put it back when it ends.
      const mode = "mono" in to ? benchMode(action.runtimeMode) : undefined;
      let changed: { runtimeMode: RuntimeMode; previousRuntimeMode: RuntimeMode | null } | undefined;
      if (mode && host.setRuntimeMode) {
        const before = host.sessions().find((session) => session.id === sessionId)?.runtimeMode ?? null;
        host.setRuntimeMode(sessionId, mode);
        changed = { runtimeMode: mode, previousRuntimeMode: before };
      }
      if ("session" in to && action.open !== false) host.openSession(sessionId, typeof action.owner === "string" ? action.owner : undefined);
      const accepted = host.submit(sessionId, text);
      return { ok: accepted, at: Date.now(), session: sessionId, ...(changed ?? {}) };
    }
    case "runtimeMode": {
      // A scene that set a Mono chat's mode puts that chat's earlier mode back when it ends (scripts/realconv/player.mjs).
      const mode = benchMode(action.runtimeMode);
      if (!mode) return { ok: false, error: `runtimeMode: unknown mode ${JSON.stringify(action.runtimeMode)}` };
      const sessionId = typeof action.session === "string" ? action.session : "";
      if (!sessionId || !host.sessions().some((session) => session.id === sessionId)) throw new Error("runtimeMode: no chat");
      if (!host.setRuntimeMode) return { ok: false, error: "runtimeMode: this window can't change a chat's mode" };
      host.setRuntimeMode(sessionId, mode);
      return { ok: true, at: Date.now(), session: sessionId, runtimeMode: mode };
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
      // A team, as its Open team does (hub/model/monoTeams.ts): a project's coding team on its Lead, or a Mono's own.
      // `unfold` opens these chats' folded sub-chats first, as Ash's click on the count does, so they can be read.
      for (const chat of Array.isArray(action.unfold) ? action.unfold : [])
        if (typeof chat === "string" && chat) openSubChats(`chat:${chat}`);
      if (typeof action.codingTeam === "string") {
        openCodingTeam(action.codingTeam, { lead: true });
        await wait(Number(action.settleMs ?? 1500));
        return { ok: true, dom: domRows() };
      }
      if (typeof action.team === "string") {
        openMonoTeam(action.team, { owner: true });
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
      // r101: `row` answers one decision of a card with several (its pick, or his words), as the row's own Send does.
      if (typeof action.row === "number") {
        const rows = openRows(waiting);
        const row = rows[action.row];
        if (!row || rows.length < 2) return { ok: false, error: `no row ${action.row} on a multi-row card (${rows.length} rows)`, session: sessionId, question: waiting.question ?? null };
        const words = typeof action.text === "string" && action.text.trim() ? action.text.trim() : (row.pick ?? "");
        const result = await answerRow(sessionId, row, words, typeof action.text === "string" && action.text.trim() ? "words" : "pick");
        return { ok: result.ok, at: Date.now(), session: sessionId, question: row.question, recommended: row.pick ?? null, decision: result.ok ? words : null, rows: rows.length, result };
      }
      const result = typeof action.text === "string" && action.text.trim() ? await answerInWords(sessionId, action.text) : await takePick(sessionId);
      // r80: `recommended` is only the agent's suggestion; `decision` is what Ash actually gave (his typed words win).
      const decision = result.ok ? (typeof action.text === "string" && action.text.trim() ? action.text.trim() : (waiting.pick ?? null)) : null;
      return { ok: true, at: Date.now(), session: sessionId, question: waiting.question ?? null, recommended: waiting.pick ?? null, decision, result };
    }
    case "retry": {
      // The Try again button on a Mono whose last turn failed (the rail, Today, Being built).
      const monoId = String(action.mono ?? "");
      const failure = monoFailure(monoId);
      if (!failure) return { ok: false, error: "that Mono's last turn didn't fail", at: Date.now() };
      const ok = retryMonoFailure(monoId);
      return { ok, at: Date.now(), reason: failure.reason, tone: failure.tone, ...(ok ? {} : { error: "it couldn't take it right now" }) };
    }
    case "approve": {
      // Ash taps Allow or Deny. With no card named, Allow on every card still waiting (a scripted step).
      // With a requestId, only that card, and only while it is still waiting.
      const sessionId = String(action.session ?? "");
      const session = host.sessions().find((s) => s.id === sessionId);
      if (!session) throw new Error("approve: no chat");
      if (!host.approve) return { ok: false, error: "approve: this window can't approve", session: sessionId };
      const pending = pendingApprovals(session);
      const decision = action.decision === "deny" ? "deny" : "allow";
      const wanted = typeof action.requestId === "number" ? pending.filter((id) => id === action.requestId) : pending;
      for (const requestId of wanted) host.approve(sessionId, requestId, decision);
      return {
        ok: true,
        at: Date.now(),
        session: sessionId,
        approved: decision === "allow" ? wanted.length : 0,
        denied: decision === "deny" ? wanted.length : 0,
        decision,
      };
    }
    case "reload":
      // The window reloads the way a vite full reload or View > Reload does (pagehide, then a fresh page), once this
      // answer is written; the page that comes back starts its own driver.
      setTimeout(() => window.location.reload(), Number(action.afterMs ?? 300));
      return { ok: true, at: Date.now() };
    case "quit": {
      // r98 (B5): Ash quits the way the app menu's Quit Hivra does (verify_live_quit -> window::request_quit), once
      // this answer is written. Never a kill: the windows save their work first. A busy chat would make that Quit ask
      // in a Mac dialog (run df53 left one up for 90s), and the bench never puts a dialog in front of Ash: refuse.
      const busy = host.sessions().filter(isRunningWork).length;
      if (busy) return { ok: false, busy, error: `${busy} chat(s) still running; Quit would ask in a Mac dialog` };
      // r99: should work start before the quit lands, the quit is called off with no dialog (appLifecycle.ts).
      armBenchQuit();
      setTimeout(() => void invoke("verify_live_quit").catch((error) => console.error("verify driver quit", error)), Number(action.afterMs ?? 300));
      return { ok: true, at: Date.now() };
    }
    case "snapshot":
      return { ok: true, ...snapshot(host) };
    case "buttons":
      return { ok: true, at: Date.now(), buttons: visibleButtons() };
    case "click": {
      const result = clickButton(String(action.label ?? ""));
      await wait(Number(action.settleMs ?? 800));
      return { ...result, at: Date.now() };
    }
    case "cleanup":
      return { ...(await cleanup(action, host)), at: Date.now() };
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
