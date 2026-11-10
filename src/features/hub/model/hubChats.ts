import { examplesOn, examples } from "./examples";
// Group chats ("rooms") per project. The live copy is kept here in memory and every change is written through to the
// room store (roomStore.ts): the app database in the app, the window's own storage in the browser preview and the
// tests. The room takes turns through roomConductor.ts (re-exported below), on each Mono's own session through the
// runner the app lends (setGroupChatRunner). Only with the example data on does a scripted reply stand in, and every
// made-up row is labelled "Example:".
import { plainTitle } from "../../../shared/text/plainTitle";
import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listMonos } from "../../monos/model/mono";
import { DEFAULT_TEAM_IDS } from "./builtInMonos";
import {
  CHAT_KEY,
  IMPORTED_KEY,
  SEATED_KEY,
  STORED_MESSAGES,
  conversationInput,
  fingerprint,
  groupChats,
  legacyBundle,
  messageInput,
  messageMeta,
  missingAfterImport,
  roomInput,
  tauriRooms,
  whenLabel,
  type RoomBackend,
} from "./roomStore";
import { councilFromUnknown, councilToJson, type CouncilRecord } from "../../council/model/record";
import type { ChatConversation, ChatMessage, GroupChat, ResponderMode, RoomAttachment } from "./types";

const m = (id: string, from: string, text: string, status?: ChatMessage["status"], refId?: string): ChatMessage => ({
  id,
  from,
  text,
  ...(status ? { status } : {}),
  ...(refId ? { refId } : {}),
});

let chats: GroupChat[] = examples([
  {
    id: "exo-game:leadership",
    projectId: "exo-game",
    name: "Leadership team",
    isDefault: true,
    memberIds: ["ada", "bo", "design-critic"],
    conversations: [
      {
        id: "c1",
        when: "Today",
        title: "Example: playtest plan",
        messages: [
          m("1", "ada", "Example: morning. The new level is in and working. Two things need you today: play Areas 1 and 2, and skim the four new rules."),
          m("2", "bo", "Example: I've kept the list short. Air and dodge rules are next for the coding team, after your playtest."),
          m("3", "ash", "Example: ok playtest after lunch. can we move level 3 to next week?"),
          m("4", "bo", "Example: yes. Moved to next week. Nothing else shifts."),
          m("5", "design-critic", "Example: I'll check the new HUD screens before they reach you."),
        ],
      },
      { id: "c2", when: "Yesterday", title: "Example: level 3 scope", messages: [m("1", "bo", "Example: level 3 is two weeks of work if we keep the boss fight.")] },
      { id: "c3", when: "12 Oct", title: "Example: monthly goals", messages: [m("1", "ada", "Example: three goals for October, parked until the playtest.")] },
    ],
  },
  {
    id: "hivra:leadership",
    projectId: "hivra",
    name: "Leadership team",
    isDefault: true,
    memberIds: ["ada", "growth-lead"],
    conversations: [
      {
        id: "c1",
        when: "Today",
        title: "Example: backups and waitlist",
        messages: [
          m("1", "ada", "Example: the nightly backup has failed 3 times since 2am. Nobody has picked it up yet.", "stuck", "s1"),
          m("2", "growth-lead", "Example: the waitlist headline test is a tie. That one is your taste call.", undefined, "n3"),
          m("3", "ada", "Example: the lead tried two fixes for the email sender. It's stuck and needs you.", "lead_gave_up", "s2"),
        ],
      },
      { id: "c2", when: "Yesterday", title: "Example: launch timing", messages: [m("1", "growth-lead", "Example: launch looks best in the second week of November.")] },
    ],
  },
  {
    id: "nibbii:leadership",
    projectId: "nibbii",
    name: "Leadership team",
    isDefault: true,
    memberIds: [],
    conversations: [],
  },
]);

export function validGroupChats(value: unknown): GroupChat[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is GroupChat => !!c && typeof c.id === "string" &&
    typeof c.projectId === "string" && typeof c.name === "string" && typeof c.isDefault === "boolean" &&
    Array.isArray(c.memberIds) && c.memberIds.every((id: unknown) => typeof id === "string") &&
    Array.isArray(c.conversations) && c.conversations.every((v: unknown) => {
      if (!v || typeof v !== "object") return false;
      const x = v as Record<string, unknown>;
      return typeof x.id === "string" && typeof x.title === "string" && typeof x.when === "string" &&
        Array.isArray(x.messages) && x.messages.every((m: unknown) => !!m && typeof m === "object" &&
          typeof (m as ChatMessage).id === "string" && typeof (m as ChatMessage).from === "string" && typeof (m as ChatMessage).text === "string");
    })).map((c) => {
      const council = councilKept((c as { council?: unknown }).council);
      const { council: _drop, ...rest } = c;
      return council ? { ...rest, council } : rest;
    });
}

/** A council kept beside a room in the window's storage. The wrong shape is dropped and the room stays. */
function councilKept(value: unknown): CouncilRecord | undefined {
  return councilFromUnknown(value) ?? undefined;
}

export { STORED_MESSAGES };

// ---- Where the rooms are kept ------------------------------------------------------------------------------------

/** The app database (in the app); none in the preview and the tests, which keep the roster in the window's storage. */
let backend: RoomBackend | undefined;
/** The store has been read (always true without a backend): until then changes wait (`whenLoaded`). */
let loaded = true;
let waiting: (() => void)[] = [];
let tail: Promise<unknown> = Promise.resolve();
/** Why the last save failed, until one works (GroupChatView shows it). */
let saveProblem: string | undefined;

function readSeated(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEATED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function problem(what: string, error: unknown): string {
  const why = error instanceof Error && error.message ? ` (${error.message.replace(/\.$/, "")})` : typeof error === "string" && error ? ` (${error.replace(/\.$/, "")})` : "";
  return `${what}${why}.`;
}

/** The whole roster in the window's storage: the preview's and the tests' store (and the old builds'). */
function saveLocal(): void {
  if (examplesOn() || backend) return;
  try {
    const stored = chats.map(({ replyPending: _p, ...c }) => ({
      ...c,
      conversations: c.conversations.map((x) =>
        x.messages.length > STORED_MESSAGES ? { ...x, messages: x.messages.slice(-STORED_MESSAGES) } : x),
    }));
    localStorage.setItem(CHAT_KEY, JSON.stringify(stored));
    localStorage.setItem(SEATED_KEY, JSON.stringify(chats.filter((c) => c.seated).map((c) => c.id)));
    saveProblem = undefined;
  } catch (error) {
    // Said once per run of failures, not on every message.
    if (!saveProblem) console.error("Could not save the group chats", error);
    saveProblem = problem("Group chats couldn't be saved", error) + " New messages may be gone after a restart.";
  }
}

/** One write to the app database, after the ones before it. A failure is shown until a later write works. */
function write(op: (b: RoomBackend) => Promise<unknown>): void {
  if (examplesOn()) return;
  const b = backend;
  if (!b) {
    saveLocal();
    return;
  }
  const run = () => op(b);
  tail = tail.then(run, run).then(
    () => {
      if (saveProblem) {
        saveProblem = undefined;
        notify();
      }
    },
    (error: unknown) => {
      if (!saveProblem) console.error("Could not save the group chats", error);
      saveProblem = problem("Group chats couldn't be saved", error) + " New messages may be gone after a restart.";
      notify();
    },
  );
}

/** Every write so far has reached the store (tests, and the migration check). */
export function roomWritesSettled(): Promise<void> {
  return tail.then(() => undefined, () => undefined);
}

function persistRoom(chat: GroupChat | undefined): void {
  if (!chat) return;
  const input = roomInput(chat);
  write((b) => b.upsertRoom(input));
}
function persistConversation(chatId: string, conversation: ChatConversation | undefined): void {
  if (!conversation) return;
  const input = conversationInput(chatId, conversation);
  write((b) => b.upsertConversation(input));
}
function persistMessage(chatId: string, convId: string, message: ChatMessage): void {
  const input = messageInput(chatId, convId, message);
  write((b) => b.addMessage(input));
}

/** Run a change now, or once the store has been read. */
function whenLoaded(change: () => void): void {
  if (loaded) change();
  else waiting.push(change);
}

/**
 * Read the rooms from the app database. The first time, the old key's rooms are copied across and read back; the old
 * key stays as it is. A conversation whose last word is Ash's, still unanswered when the app closed, says so (Try
 * again), so the room never goes quiet on him.
 */
export async function loadRooms(from: RoomBackend, now = Date.now()): Promise<void> {
  backend = from;
  loaded = false;
  let problemText: string | undefined;
  try {
    let snapshot = await from.load();
    // No store answering (the browser preview's stand-in for the app): keep the rooms in the window's storage.
    if (!snapshot || !Array.isArray((snapshot as { rooms?: unknown }).rooms)) {
      backend = undefined;
      loadLocal();
      return;
    }
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CHAT_KEY);
    } catch {
      raw = null;
    }
    const legacy = raw ? validGroupChats(safeParse(raw)) : [];
    if (raw && legacy.length && localStorage.getItem(IMPORTED_KEY) !== fingerprint(raw)) {
      const bundle = legacyBundle(legacy, readSeated(), now);
      await from.import({ ...bundle, mark: "legacy_import" });
      snapshot = await from.load();
      const missing = missingAfterImport(bundle, snapshot);
      if (missing) problemText = `${missing}. The old copy is kept in this window's storage.`;
      else localStorage.setItem(IMPORTED_KEY, fingerprint(raw));
    }
    const stored = groupChats(snapshot, now);
    const ids = new Set(stored.map((c) => c.id));
    // Anything made before the store answered stays (its writes are queued behind the read).
    const early = chats.filter((c) => !ids.has(c.id));
    chats = [...stored.map((c) => {
      const mine = chats.find((x) => x.id === c.id);
      const extra = mine?.conversations.filter((v) => !c.conversations.some((s) => s.id === v.id)) ?? [];
      return withCutOff(extra.length ? { ...c, conversations: [...extra, ...c.conversations] } : c, now);
    }), ...early];
  } catch (error) {
    problemText = problem("Group chats couldn't be loaded", error);
  } finally {
    saveProblem = problemText;
    loaded = true;
    const run = waiting;
    waiting = [];
    for (const change of run) change();
    changed();
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Ash's last message in a conversation, unanswered when the app closed less than a day ago: offer Try again. */
function withCutOff(chat: GroupChat, now: number): GroupChat {
  for (const conv of chat.conversations) {
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.from !== "ash" || conv.answeredThrough === last.id) continue;
    if (last.at !== undefined && now - last.at > 24 * 60 * 60_000) continue;
    return {
      ...chat,
      replyConversationId: conv.id,
      replyMessageId: last.id,
      replyError: "The room's answer was cut off when the app closed. Your message is saved.",
    };
  }
  return chat;
}

/** The window's storage: the roster as an older build (or the preview) left it. */
function loadLocal(): void {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]");
    const seated = readSeated();
    chats = validGroupChats(saved).map((c) => ({
      ...(c.replyPending ? { ...c, replyPending: undefined, replyError: "The previous reply was interrupted. Check the Mono's conversation before trying again." } : c),
      ...(seated.has(c.id) ? { seated: true } : {}),
    }));
  } catch { /* keep a clean roster if storage is unavailable */ }
}

// The live copy at start: the examples, the app database (read now, in the background), or the window's storage.
if (!examplesOn()) {
  let inApp = false;
  try {
    inApp = isTauri();
  } catch {
    inApp = false;
  }
  if (inApp) void loadRooms(tauriRooms);
  else loadLocal();
}

/** The store in use, for the agents' reads of older messages ("app" or "window"). */
export function roomBackend(): RoomBackend | undefined {
  return backend;
}

// ---- Change notification --------------------------------------------------------------------------------------------

const EVENT = "monocode:hub-chats-changed";
let version = 0;
/** Re-render only (nothing to save): typing indicators, problems. */
export function notify(): void {
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
/** In the window's storage, the whole roster is written on every change; in the app, each change wrote its own row. */
function changed(): void {
  if (!backend) saveLocal();
  notify();
}

/** Why the group chats couldn't be saved or loaded, while they can't. */
export function chatSaveProblem(): string | undefined {
  return saveProblem;
}
function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
/** Re-render on any chat change. */
export function useHubChatsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// ---- Rooms ------------------------------------------------------------------------------------------------------

export function leadershipChatId(projectId: string): string {
  return `${projectId}:leadership`;
}

export function listChats(projectId: string): GroupChat[] {
  return chats.filter((c) => c.projectId === projectId);
}

/** Every room (the agents' room tools look rooms up by id or name). */
export function allChats(): readonly GroupChat[] {
  return chats;
}

export function getChat(id: string): GroupChat | undefined {
  return chats.find((c) => c.id === id);
}

function update(chatId: string, change: (chat: GroupChat) => GroupChat): GroupChat | undefined {
  let next: GroupChat | undefined;
  chats = chats.map((c) => (c.id === chatId ? (next = change(c)) : c));
  return next;
}

/** Every project has a Leadership team. It is made empty here; seatDefaultTeam seats the default team once. */
export function ensureLeadership(projectId: string): GroupChat {
  const id = leadershipChatId(projectId);
  const existing = getChat(id);
  if (existing) return existing;
  const chat: GroupChat = { id, projectId, name: "Leadership team", isDefault: true, memberIds: [], conversations: [] };
  // Before the store is read, the room may be there already: make it then, if it still isn't.
  if (!loaded) {
    whenLoaded(() => void ensureLeadership(projectId));
    return chat;
  }
  chats = [...chats, chat];
  persistRoom(chat);
  changed();
  return chat;
}

/**
 * A project's Leadership team gets the default team (Chief of Staff, Projects Manager, ed, Alfred, as far as they
 * are on the roster) once, ahead of anyone already in it (Ash 14 Oct: every first project ships with them). Once per
 * chat: a Mono Ash takes out of the chat stays out, and one he removed from the roster is never added. Returns the chat.
 */
export function seatDefaultTeam(projectId: string): GroupChat {
  if (!loaded) {
    whenLoaded(() => void seatDefaultTeam(projectId));
    return ensureLeadership(projectId);
  }
  const chat = ensureLeadership(projectId);
  if (examplesOn() || chat.seated) return chat;
  const roster = new Set(listMonos().map((m) => m.id));
  const team = DEFAULT_TEAM_IDS.filter((id) => roster.has(id));
  if (!team.length) return chat; // the roster isn't ready yet: try again next time
  const add = team.filter((id) => !chat.memberIds.includes(id));
  const next = update(chat.id, (c) => ({ ...c, seated: true, memberIds: [...add, ...c.memberIds] }));
  persistRoom(next);
  changed();
  return next ?? chat;
}

export function createChat(projectId: string, name: string, memberIds: string[]): GroupChat {
  const chat: GroupChat = {
    id: `${projectId}:chat-${crypto.randomUUID()}`,
    projectId,
    name: name.trim() || "New chat",
    isDefault: false,
    memberIds: [...new Set(memberIds)],
    conversations: [],
  };
  chats = [...chats, chat];
  persistRoom(chat);
  changed();
  return chat;
}

/**
 * Deletes a room Ash made (r30d), after the shared confirm: the room and its own threads and messages, nothing else (no
 * Mono, soul, memory or other hub data). A project's Leadership team is not deleted: every project has one.
 */
const goneListeners = new Set<(gone: { chatId: string; convId?: string }) => void>();

/**
 * Told when Ash deletes a room conversation, or a whole room (no `convId`): the app drops each Mono's session for it
 * (r52), so its turns go with it.
 */
export function onConversationGone(listener: (gone: { chatId: string; convId?: string }) => void): () => void {
  goneListeners.add(listener);
  return () => void goneListeners.delete(listener);
}

function gone(chatId: string, convId?: string): void {
  for (const listener of [...goneListeners]) {
    try {
      listener(convId === undefined ? { chatId } : { chatId, convId });
    } catch (error) {
      console.warn("A room conversation's sessions could not be let go", error);
    }
  }
}

export function deleteChat(chatId: string): boolean {
  const chat = getChat(chatId);
  if (!chat || chat.isDefault) return false;
  chats = chats.filter((c) => c.id !== chatId);
  write((b) => b.deleteRoom?.(chatId) ?? Promise.reject(new Error("This store can't delete a room yet.")));
  changed();
  gone(chatId);
  return true;
}

/**
 * Deletes one conversation of a room (r49), after the shared confirm: its messages go, the room and its other
 * conversations stay. The Leadership team's old conversations can go too, so a fresh one starts clean.
 */
export function deleteConversation(chatId: string, convId: string): boolean {
  const chat = getChat(chatId);
  if (!chat?.conversations.some((c) => c.id === convId)) return false;
  update(chatId, (c) => ({ ...c, conversations: c.conversations.filter((x) => x.id !== convId) }));
  write((b) => b.deleteConversation?.(chatId, convId) ?? Promise.reject(new Error("This store can't delete a conversation yet.")));
  changed();
  gone(chatId, convId);
  return true;
}

export function addMember(chatId: string, monoId: string): void {
  whenLoaded(() => {
    const chat = getChat(chatId);
    if (!chat || chat.memberIds.includes(monoId)) return;
    persistRoom(update(chatId, (c) => ({ ...c, memberIds: [...c.memberIds, monoId] })));
    changed();
  });
}

export function removeMember(chatId: string, monoId: string): void {
  whenLoaded(() => {
    if (!getChat(chatId)?.memberIds.includes(monoId)) return;
    persistRoom(update(chatId, (c) => ({ ...c, memberIds: c.memberIds.filter((id) => id !== monoId) })));
    changed();
  });
}

export function renameChat(chatId: string, name: string): void {
  const next = name.trim();
  if (!next) return;
  whenLoaded(() => {
    persistRoom(update(chatId, (c) => ({ ...c, name: next })));
    changed();
  });
}

/** Who answers Ash first in a room (unset: Chief of Staff when seated, else the first member). */
export function setRoomLead(chatId: string, monoId: string | undefined): void {
  whenLoaded(() => {
    persistRoom(update(chatId, (c) => {
      const { leadId: _, ...rest } = c;
      return monoId ? { ...rest, leadId: monoId } : rest;
    }));
    changed();
  });
}

/** WP-22: who answers in a room (roomModes.ts). "everyone", the default, is stored as nothing. */
export function setRoomResponder(chatId: string, mode: ResponderMode): void {
  whenLoaded(() => {
    persistRoom(update(chatId, (c) => {
      const { responder: _, ...rest } = c;
      return mode === "everyone" ? rest : { ...rest, responder: mode };
    }));
    changed();
  });
}

/**
 * WP-23: keep a council on its room. The write lands only when `expectedRevision` is still the revision in memory
 * (0 when the room has no council). A second window that saved first makes this return false and, once the store
 * answers, the row that won replaces the one this window had guessed.
 */
export function saveCouncil(chatId: string, next: CouncilRecord, expectedRevision: number): boolean {
  const chat = getChat(chatId);
  if (!chat || (chat.council?.revision ?? 0) !== expectedRevision) return false;
  const json = councilToJson({ ...next, revision: expectedRevision + 1 });
  if (!json) return false;
  const stored = councilFromUnknown(JSON.parse(json));
  if (!stored) return false;
  update(chatId, (c) => ({ ...c, council: stored }));
  if (backend?.setCouncil) {
    const written = stored.revision;
    write(async (b) => {
      const result = await b.setCouncil!(chatId, expectedRevision, json);
      if (result.applied !== false) return;
      if (getChat(chatId)?.council?.revision !== written) return;
      let adopted: CouncilRecord | null = null;
      try {
        adopted = councilFromUnknown(JSON.parse(result.json));
      } catch {
        adopted = null;
      }
      if (adopted) {
        update(chatId, (c) => ({ ...c, council: adopted }));
        changed();
        return;
      }
      // The row is gone (revision 0 and no council to read). Put this one back, once, and keep whatever landed.
      if (result.revision !== 0) return;
      const retryJson = councilToJson({ ...stored, revision: 1 });
      if (!retryJson) return;
      const again = await b.setCouncil!(chatId, 0, retryJson);
      if (getChat(chatId)?.council?.revision !== written) return;
      if (again.applied === false) return;
      let landed: CouncilRecord | null = null;
      try {
        landed = councilFromUnknown(JSON.parse(again.json));
      } catch {
        landed = null;
      }
      if (!landed) return;
      update(chatId, (c) => ({ ...c, council: landed }));
      changed();
    });
  }
  changed();
  return true;
}

// ---- Conversations and messages -----------------------------------------------------------------------------------

/** A conversation names itself from its first message: the first line, cut at a word near 40 characters. */
export function autoTitle(text: string): string {
  const line = plainTitle(text.trim().split("\n")[0] ?? ""); // r51: plain text, never the message's markdown
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(" ");
  return `${space > 20 ? cut.slice(0, space) : cut}…`;
}

let seq = 0;
/** A message id: its time first, so the order of ids is the order of messages. */
export function newMessageId(from: string): string {
  return `${Date.now().toString(36)}-${from.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "x"}-${(++seq).toString(36)}`;
}

function newConversationRecord(id: string, title: string, at: number, messages: ChatMessage[] = []): ChatConversation {
  return { id, when: whenLabel(at, at), title, createdAt: at, messages };
}

/** Keep a conversation's newest STORED_MESSAGES in memory (the store keeps them all). */
function capped(conv: ChatConversation): ChatConversation {
  return conv.messages.length > STORED_MESSAGES ? { ...conv, messages: conv.messages.slice(-STORED_MESSAGES), more: true } : conv;
}

/**
 * Add a message to a conversation (the newest one when none is named; a new one, named from the text, when the room
 * has none). Returns where it went, or nothing when the room is gone.
 */
export function appendMessage(
  chatId: string,
  convId: string | undefined,
  message: Omit<ChatMessage, "id" | "at"> & { id?: string; at?: number },
): { convId: string; message: ChatMessage } | undefined {
  const chat = getChat(chatId);
  if (!chat) return undefined;
  const at = message.at ?? Date.now();
  const full: ChatMessage = { ...message, id: message.id ?? newMessageId(message.from), at };
  const target = (convId && chat.conversations.find((x) => x.id === convId)) || (convId ? undefined : chat.conversations[0]);
  if (!target) {
    const id = convId ?? `conv-${at.toString(36)}-${++seq}`;
    const conv = newConversationRecord(id, autoTitle(message.text) || "Conversation", at, [full]);
    update(chatId, (c) => ({ ...c, conversations: [conv, ...c.conversations] }));
    persistConversation(chatId, conv);
    persistMessage(chatId, id, full);
    changed();
    return { convId: id, message: full };
  }
  if (target.messages.some((x) => x.id === full.id)) return { convId: target.id, message: target.messages.find((x) => x.id === full.id)! };
  update(chatId, (c) => ({
    ...c,
    conversations: c.conversations.map((x) => (x.id === target.id ? capped({ ...x, messages: [...x.messages, full] }) : x)),
  }));
  persistMessage(chatId, target.id, full);
  changed();
  return { convId: target.id, message: full };
}

/** A conversation's name from its first message: its words, else what was attached ("plan.pdf, photo.png"). */
function firstTitle(text: string, attachments?: readonly RoomAttachment[]): string {
  return autoTitle(text) || autoTitle((attachments ?? []).map((a) => a.name).join(", ")) || "Conversation";
}

/**
 * Ash writes in a conversation (the newest, or a new one when there is none from today), with anything he attached.
 * Returns the message id.
 */
export function sendMessage(chatId: string, text: string, convId?: string, attachments?: readonly RoomAttachment[]): string {
  const at = Date.now();
  const msg: ChatMessage = { id: crypto.randomUUID(), from: "ash", kind: "ash", text, at, ...(attachments?.length ? { attachments: [...attachments] } : {}) };
  whenLoaded(() => {
    const c = getChat(chatId);
    if (!c) return;
    const target = convId ? c.conversations.find((x) => x.id === convId) : undefined;
    if (target) {
      // Only a conversation nobody named takes its name from the first message: Ash's own name always stays.
      const retitle = !target.messages.length && !target.named;
      update(chatId, (chat) => ({
        ...chat,
        conversations: chat.conversations.map((x) =>
          x.id === target.id ? capped({ ...x, title: retitle ? firstTitle(text, attachments) : x.title, messages: [...x.messages, msg] }) : x),
      }));
      if (retitle) persistConversation(chatId, getChat(chatId)?.conversations.find((x) => x.id === target.id));
      persistMessage(chatId, target.id, msg);
      changed();
      return;
    }
    const [first] = c.conversations;
    if (first && first.when === "Today") {
      appendMessage(chatId, first.id, msg);
      return;
    }
    const conv = newConversationRecord(msg.id, firstTitle(text, attachments), at, [msg]);
    update(chatId, (chat) => ({ ...chat, conversations: [conv, ...chat.conversations] }));
    persistConversation(chatId, conv);
    persistMessage(chatId, conv.id, msg);
    changed();
  });
  return msg.id;
}

/** Ash renames a conversation (double-click its name). Empty keeps the old name. */
export function renameConversation(chatId: string, convId: string, title: string): void {
  const next = title.trim();
  if (!next) return;
  whenLoaded(() => {
    update(chatId, (c) => ({ ...c, conversations: c.conversations.map((x) => (x.id === convId ? { ...x, title: next, named: true } : x)) }));
    persistConversation(chatId, getChat(chatId)?.conversations.find((x) => x.id === convId));
    changed();
  });
}

/**
 * The New conversation screen sends its first message: only now is a conversation made. It is named from that message
 * unless Ash already named it on the screen (then it stays his name). Returns its id.
 */
export function startConversation(
  chatId: string,
  text: string,
  options: { title?: string; attachments?: readonly RoomAttachment[] } = {},
): string {
  const at = Date.now();
  const id = `conv-${at.toString(36)}-${++seq}`;
  const attachments = options.attachments?.length ? { attachments: [...options.attachments] } : {};
  const msg: ChatMessage = { id: `${id}-1`, from: "ash", kind: "ash", text, at, ...attachments };
  const named = options.title?.trim();
  const conv: ChatConversation = {
    ...newConversationRecord(id, named || firstTitle(text, options.attachments), at, [msg]),
    ...(named ? { named: true } : {}),
  };
  update(chatId, (c) => ({ ...c, conversations: [conv, ...c.conversations] }));
  persistConversation(chatId, conv);
  persistMessage(chatId, id, msg);
  changed();
  return id;
}

/** Start a fresh conversation at the top of the list; returns its id. */
export function newConversation(chatId: string): string {
  const at = Date.now();
  const id = `conv-${at.toString(36)}-${++seq}`;
  const conv = newConversationRecord(id, "New conversation", at);
  update(chatId, (c) => ({ ...c, conversations: [conv, ...c.conversations] }));
  persistConversation(chatId, conv);
  changed();
  return id;
}

/** The last of Ash's messages the room has taken up in a conversation (unset: back to "the run since the last reply"). */
export function setAnsweredThrough(chatId: string, convId: string, through: string | undefined): void {
  update(chatId, (c) => ({
    ...c,
    conversations: c.conversations.map((x) => {
      if (x.id !== convId) return x;
      const { answeredThrough: _, ...rest } = x;
      return through === undefined ? rest : { ...x, answeredThrough: through };
    }),
  }));
  persistConversation(chatId, getChat(chatId)?.conversations.find((x) => x.id === convId));
  changed();
}

/** Ash's messages in a conversation that no answer has taken up yet (oldest first). */
export function unanswered(conv: ChatConversation): ChatMessage[] {
  if (conv.answeredThrough !== undefined) {
    const at = conv.messages.findIndex((m) => m.id === conv.answeredThrough);
    if (at >= 0) return conv.messages.slice(at + 1).filter((m) => m.from === "ash");
  }
  // No marker (older data, or nothing answered yet): Ash's messages since the last Mono's reply (the app's own lines,
  // a notice or a pause, don't count as a reply).
  const out: ChatMessage[] = [];
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.from === "ash") out.unshift(m);
    else if (m.from !== "app" && m.kind !== "notice" && m.kind !== "system") break;
  }
  return out;
}

/** The conversation a message is in. */
export function conversationOf(chatId: string, messageId: string): ChatConversation | undefined {
  return getChat(chatId)?.conversations.find((c) => c.messages.some((x) => x.id === messageId));
}

/** Allowed reactions: an acknowledgement, a done, a looking-at-it. */
export const REACTIONS = ["👍", "✅", "👀"] as const;

/**
 * `who` reacts to a message with `emoji` (on: add; off: take back; neither: toggle). Returns the message's reactions,
 * or nothing when it isn't there.
 */
export function react(chatId: string, messageId: string, who: string, emoji: string, on?: boolean): Record<string, string[]> | undefined {
  const conv = conversationOf(chatId, messageId);
  const message = conv?.messages.find((x) => x.id === messageId);
  if (!conv || !message || !(REACTIONS as readonly string[]).includes(emoji)) return undefined;
  const list = message.reactions?.[emoji] ?? [];
  const has = list.includes(who);
  const add = on ?? !has;
  if (add === has) return message.reactions ?? {};
  const nextList = add ? [...list, who] : list.filter((x) => x !== who);
  const reactions = { ...(message.reactions ?? {}) };
  if (nextList.length) reactions[emoji] = nextList;
  else delete reactions[emoji];
  update(chatId, (c) => ({
    ...c,
    conversations: c.conversations.map((x) =>
      x.id === conv.id ? { ...x, messages: x.messages.map((y) => (y.id === messageId ? { ...y, reactions } : y)) } : x),
  }));
  write((b) => b.updateMessage({ roomId: chatId, id: messageId, reactions }));
  changed();
  return reactions;
}

/** A message's notice is settled (its Try again ran): it stays, without the button. */
export function settleNotice(chatId: string, messageId: string): void {
  const conv = conversationOf(chatId, messageId);
  const message = conv?.messages.find((x) => x.id === messageId);
  if (!conv || !message?.notice?.retry) return;
  const next: ChatMessage = { ...message, notice: { ...message.notice, retry: false } };
  update(chatId, (c) => ({
    ...c,
    conversations: c.conversations.map((x) => (x.id === conv.id ? { ...x, messages: x.messages.map((y) => (y.id === messageId ? next : y)) } : x)),
  }));
  const meta = messageMeta(next);
  write((b) => b.updateMessage({ roomId: chatId, id: messageId, meta }));
  changed();
}

/** Runtime state the room shows (who is answering, why the last answer failed); not stored. */
export function setRoomRuntime(chatId: string, change: Partial<Pick<GroupChat, "replyPending" | "replyError" | "replyConversationId" | "replyMessageId">>): void {
  update(chatId, (c) => {
    const next = { ...c };
    for (const [key, value] of Object.entries(change) as [keyof typeof change, string | undefined][]) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  });
  if (!backend) saveLocal();
  notify();
}

/**
 * A room's messages for the agents: after `since` (a message id) or the newest `limit`, in one conversation or all,
 * oldest first. Older messages than the window keeps come from the store.
 */
export async function readRoom(
  chatId: string,
  options: { conversation?: string; since?: string; limit?: number } = {},
): Promise<{ convId: string; message: ChatMessage }[]> {
  const chat = getChat(chatId);
  if (!chat) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
  const all = chat.conversations
    .filter((c) => !options.conversation || c.id === options.conversation)
    .flatMap((c) => c.messages.map((message) => ({ convId: c.id, message })))
    .sort((a, b) => (a.message.at ?? 0) - (b.message.at ?? 0));
  if (!options.since) return all.slice(-limit);
  const at = all.findIndex((x) => x.message.id === options.since);
  if (at >= 0) return all.slice(at + 1, at + 1 + limit);
  if (!backend) throw new Error(`No message ${options.since} in this room`);
  const { chatMessage } = await import("./roomStore");
  const older = await backend.read(chatId, { conversation: options.conversation, since: options.since, limit });
  return older.map((m) => ({ convId: m.conversationId, message: chatMessage(m) }));
}

/**
 * What an imported room's message says in place of its files. A file's path comes from the Mac that made the export (or
 * from a file written by hand), never from this one, and a room hands each attachment's path to the Mono that answers
 * and prints it in the transcript it shows its Monos. So the attachments are dropped and the message says so; its text
 * and the rest of the message stay.
 */
function withoutImportedFiles(message: ChatMessage): ChatMessage {
  const files = (message as { attachments?: unknown }).attachments;
  if (files === undefined) return message;
  const { attachments: _files, ...rest } = message;
  const names = (Array.isArray(files) ? files : []).flatMap((file: unknown) => {
    const name = (file as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
  if (names.length === 0) return rest;
  const note = `[Attached: ${names.join(", ")}. The files are not on this Mac.]`;
  return { ...rest, text: rest.text ? `${rest.text}\n\n${note}` : note };
}

function withoutImportedFilePaths(chats: GroupChat[]): GroupChat[] {
  return chats.map((c) => ({
    ...c,
    conversations: c.conversations.map((conv) => ({ ...conv, messages: conv.messages.map(withoutImportedFiles) })),
  }));
}

/**
 * Restore exported chats without duplicating an existing conversation. With `mergeConversations`, a chat that is
 * already here gains the file's conversations it doesn't have (its own are never touched). Returns how many chats
 * and conversations were added.
 */
export function importChats(imported: GroupChat[], { mergeConversations = false }: { mergeConversations?: boolean } = {}): { chats: number; conversations: number } {
  const present = new Set(chats.map((c) => c.id));
  const valid = withoutImportedFilePaths(validGroupChats(imported));
  let conversations = 0;
  const addedConversations: { chatId: string; conv: ChatConversation }[] = [];
  if (mergeConversations) {
    chats = chats.map((c) => {
      const from = valid.find((v) => v.id === c.id);
      if (!from) return c;
      const have = new Set(c.conversations.map((v) => v.id));
      const add = from.conversations.filter((v) => !have.has(v.id));
      conversations += add.length;
      for (const conv of add) addedConversations.push({ chatId: c.id, conv });
      return add.length ? { ...c, conversations: [...c.conversations, ...add] } : c;
    });
  }
  const additions = valid.filter((c) => {
    if (present.has(c.id)) return false;
    present.add(c.id); return true;
  }).map((c) => ({ ...c, replyPending: undefined }));
  conversations += additions.reduce((n, c) => n + c.conversations.length, 0);
  chats = [...chats, ...additions];
  if (backend && (additions.length || addedConversations.length)) {
    const bundle = legacyBundle(additions, new Set(additions.filter((c) => c.seated).map((c) => c.id)));
    for (const { chatId, conv } of addedConversations) {
      const one = legacyBundle([{ ...getChat(chatId)!, conversations: [conv] }], new Set());
      bundle.conversations.push(...one.conversations);
      bundle.messages.push(...one.messages);
    }
    write((b) => b.import(bundle));
  }
  changed();
  return { chats: additions.length, conversations };
}
export function exportChats(): GroupChat[] { return structuredClone(chats); }

/** Tests: forget everything (and the store in use). */
export function resetRoomsForTests(next: GroupChat[] = []): void {
  chats = next;
  backend = undefined;
  loaded = true;
  waiting = [];
  tail = Promise.resolve();
  saveProblem = undefined;
}

// The room taking turns lives in roomConductor.ts; these are its door for the app and the screens.
export {
  continueGoal,
  endRoomGoal,
  keepGoing,
  MonoBusyError,
  postBack,
  postFromMono,
  postReport,
  replyProblem,
  requestReply,
  retryNotice,
  retryReply,
  retryRoomNote,
  roomActive,
  roomDrafts,
  roomIdle,
  roomPaused,
  roomPauseReason,
  roomGoal,
  roomPick,
  roomStrip,
  setRoomDecider,
  startGoal,
  roomTurnOf,
  roomTurnsByMono,
  roomWorking,
  setGroupChatRunner,
  simulateReplies,
  stopRoom,
  typingIn,
  type GroupChatRunner,
  type RoomDraft,
  type RoomGoal,
  type RoomStrip,
  type RoomTurnOutcome,
  type RoomTurnRequest,
  type RoomWakeEnd,
  type RoomWorker,
} from "./roomConductor";
