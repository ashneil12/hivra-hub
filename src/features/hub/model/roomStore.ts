// Where the rooms (group chats) are kept (docs/leadership/ROOM.md). In the app: the app database through
// src-tauri/src/rooms.rs, which the agents' room tools read too. In the browser preview and the unit tests: the window's
// own storage, as before. hubChats.ts keeps the live copy in memory and writes every change through one of these.
//
// The rooms used to live only in the window's storage (`monocode:hub-chats`). The first launch of a build with the
// store copies them across (rooms, seats, threads and every message, by id, so running it again adds nothing) and
// reads them back; the old key stays where it is, untouched, until the copy is confirmed and beyond, so a rolled-back
// build still finds its chats. Anything an older build wrote there later comes across on the next launch.
import { invoke } from "@tauri-apps/api/core";
import { councilFromUnknown } from "../../council/model/record";
import type { ChatConversation, ChatMessage, ChatMessageKind, GroupChat, RoomAttachment } from "./types";

export const CHAT_KEY = "monocode:hub-chats";
export const SEATED_KEY = "monocode:hub-leadership-seated";
/** What the last copy of the old key carried, so an unchanged key isn't sent again on every launch. */
export const IMPORTED_KEY = "monocode:hub-chats-imported";
/** How many of a conversation's newest messages the window keeps (and the old key kept). */
export const STORED_MESSAGES = 500;

export type StoredMessage = {
  seq: number;
  id: string;
  conversationId: string;
  author: string;
  kind: ChatMessageKind;
  text: string;
  replyTo?: string;
  meta: Record<string, unknown>;
  reactions: Record<string, unknown>;
  createdAt: number;
};

export type StoredConversation = {
  id: string;
  title: string;
  named: boolean;
  answeredThrough?: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  more: boolean;
};

export type StoredRoom = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  leadId?: string;
  /** WP-22: the room's responder mode; unset is "everyone". */
  responder?: string;
  seated: boolean;
  createdAt: number;
  updatedAt: number;
  memberIds: string[];
  conversations: StoredConversation[];
  /** WP-23: the council row's JSON, when this room has one. Unset on an older store. */
  councilJson?: string;
};

export type RoomSnapshot = { rooms: StoredRoom[]; legacyImport?: Record<string, unknown> };

export type RoomInput = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  leadId?: string;
  responder?: string;
  seated: boolean;
  memberIds: string[];
  createdAt?: number;
};
export type ConversationInput = {
  roomId: string;
  id: string;
  title: string;
  named: boolean;
  answeredThrough?: string;
  createdAt?: number;
};
export type MessageInput = {
  roomId: string;
  conversationId: string;
  id: string;
  author: string;
  kind: ChatMessageKind;
  text: string;
  replyTo?: string;
  meta?: Record<string, unknown>;
  reactions?: Record<string, string[]>;
  createdAt?: number;
};
export type ImportBundle = {
  rooms: RoomInput[];
  conversations: ConversationInput[];
  messages: MessageInput[];
  mark?: string;
};
export type ImportReport = { rooms: number; conversations: number; messages: number };

/** Work a Mono delegated from a room turn: its result comes back into that room. */
export type RoomOrigin = {
  childSession: string;
  roomId: string;
  conversationId: string;
  monoId: string;
  ownerSession: string;
  title: string;
  createdAt?: number;
};

export type RoomBackend = {
  /** The store's name in messages ("the app database"). */
  kind: "app" | "window";
  load(): Promise<RoomSnapshot>;
  upsertRoom(room: RoomInput): Promise<void>;
  /** Deletes one room with its seats, threads, messages and origins, and nothing else (r30d). */
  deleteRoom?(id: string): Promise<void>;
  /** Deletes one conversation of a room with its messages, and nothing else (r49). */
  deleteConversation?(room: string, id: string): Promise<void>;
  upsertConversation(conversation: ConversationInput): Promise<void>;
  addMessage(message: MessageInput): Promise<unknown>;
  updateMessage(patch: { roomId: string; id: string; meta?: Record<string, unknown>; reactions?: Record<string, string[]> }): Promise<unknown>;
  read(room: string, options: { conversation?: string; since?: string; limit?: number }): Promise<StoredMessage[]>;
  import(bundle: ImportBundle): Promise<ImportReport>;
  addOrigin(origin: RoomOrigin): Promise<void>;
  openOrigins(): Promise<RoomOrigin[]>;
  originDone(childSession: string): Promise<boolean>;
  /**
   * WP-23: write the council row only when `expectedRevision` is still the one stored (0 when there is none). A lost
   * race comes back `applied: false` with the row that won. The room upsert never touches this row.
   */
  setCouncil?(roomId: string, expectedRevision: number, json: string): Promise<{ applied: boolean; revision: number; json: string }>;
};

export const tauriRooms: RoomBackend = {
  kind: "app",
  load: () => invoke("rooms_load"),
  upsertRoom: (room) => invoke("rooms_upsert", { room }),
  deleteRoom: (id) => invoke("rooms_delete", { id }),
  deleteConversation: (room, id) => invoke("rooms_conversation_delete", { room, id }),
  upsertConversation: (conversation) => invoke("rooms_conversation_upsert", { conversation }),
  addMessage: (message) => invoke("rooms_message_add", { message }),
  updateMessage: (patch) => invoke("rooms_message_update", { patch }),
  read: (room, options) =>
    invoke("rooms_read", { room, conversation: options.conversation ?? null, since: options.since ?? null, limit: options.limit ?? null }),
  import: (bundle) => invoke("rooms_import", { bundle }),
  addOrigin: (origin) => invoke("rooms_origin_add", { origin: { ...origin, createdAt: origin.createdAt ?? 0 } }),
  openOrigins: () => invoke("rooms_origins_open"),
  originDone: (childSession) => invoke("rooms_origin_done", { childSession }),
  // WP-23: the council is its own row, so a later room save cannot wipe it.
  setCouncil: (roomId, expectedRevision, json) => invoke("rooms_set_council", { roomId, expectedRevision, json }),
};

// ---- Shapes ------------------------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** "Today", "Yesterday" or "12 Oct", for a conversation started at `at`. */
export function whenLabel(at: number, now = Date.now()): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (at >= start.getTime()) return "Today";
  if (at >= start.getTime() - DAY) return "Yesterday";
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The time an id made by `Date.now().toString(36)` carries (conv-<t>, a reply's id), when it plausibly does. */
export function timeInId(id: string): number | undefined {
  // Eight base-36 digits until 2059; an old reply's id runs straight on into the Mono's id ("mgx1k2abmono3").
  const match = /^(?:conv-)?([0-9a-z]{8})/.exec(id);
  if (!match) return undefined;
  const at = parseInt(match[1], 36);
  // 2020 to 2100: anything else is a different kind of id.
  return at > 1_577_836_800_000 && at < 4_102_444_800_000 ? at : undefined;
}

function kindOf(message: ChatMessage): ChatMessageKind {
  return message.kind ?? (message.from === "ash" ? "ash" : "mono");
}

/** What a message carries beyond author, kind, text and reply (kept as one small object). */
export function messageMeta(message: ChatMessage): Record<string, unknown> {
  return {
    ...(message.quiet ? { quiet: true } : {}),
    ...(message.refId ? { refId: message.refId } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.pick ? { pick: message.pick } : {}),
    ...(message.notice ? { notice: message.notice } : {}),
    ...(message.gather ? { gather: message.gather } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(roomAttachment) } : {}),
  };
}

/** Only what finds the file again: never its bytes or a preview link. */
function roomAttachment(file: RoomAttachment): RoomAttachment {
  return { id: file.id, name: file.name, mimeType: file.mimeType, kind: file.kind, size: file.size, path: file.path };
}

/** Attachments as the store has them (anything not a file on disk is left out). */
export function attachmentsOf(value: unknown): RoomAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((v): RoomAttachment[] => {
    if (!v || typeof v !== "object") return [];
    const x = v as Record<string, unknown>;
    if (typeof x.path !== "string" || !x.path || typeof x.name !== "string") return [];
    const kind = x.kind === "image" || x.kind === "audio" ? x.kind : "file";
    return [{
      id: typeof x.id === "string" && x.id ? x.id : x.path,
      name: x.name,
      mimeType: typeof x.mimeType === "string" ? x.mimeType : "application/octet-stream",
      kind,
      size: typeof x.size === "number" ? x.size : 0,
      path: x.path,
    }];
  });
  return out.length ? out : undefined;
}

export function messageInput(roomId: string, conversationId: string, message: ChatMessage): MessageInput {
  const meta = messageMeta(message);
  return {
    roomId,
    conversationId,
    id: message.id,
    author: message.from,
    kind: kindOf(message),
    text: message.text,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(message.reactions && Object.keys(message.reactions).length ? { reactions: message.reactions } : {}),
    ...(message.at ? { createdAt: message.at } : {}),
  };
}

export function roomInput(chat: GroupChat): RoomInput {
  return {
    id: chat.id,
    projectId: chat.projectId,
    name: chat.name,
    isDefault: chat.isDefault,
    ...(chat.leadId ? { leadId: chat.leadId } : {}),
    // Only a mode the store accepts: anything else (an imported or hand-edited value) is saved as everyone.
    ...(isResponderMode(chat.responder) ? { responder: chat.responder } : {}),
    seated: !!chat.seated,
    memberIds: [...chat.memberIds],
  };
}

export function conversationInput(roomId: string, conversation: ChatConversation): ConversationInput {
  return {
    roomId,
    id: conversation.id,
    title: conversation.title,
    named: !!conversation.named,
    ...(conversation.answeredThrough ? { answeredThrough: conversation.answeredThrough } : {}),
    ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}),
  };
}

/** WP-22: the modes roomModes.ts knows (kept here too so the store stays free of the room's rules). */
const RESPONDERS = new Set(["lead", "mentions", "auto"]);
function isResponderMode(value: unknown): value is "lead" | "mentions" | "auto" {
  return typeof value === "string" && RESPONDERS.has(value);
}

const PICKS = new Set(["mention", "only", "named", "lead", "router", "lanes", "room", "chime", "addressed", "digest", "report", "back", "post", "auto", "goal"]);

function reactionsOf(value: Record<string, unknown>): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const [emoji, who] of Object.entries(value))
    if (Array.isArray(who)) {
      const list = who.filter((x): x is string => typeof x === "string");
      if (list.length) out[emoji] = list;
    }
  return Object.keys(out).length ? out : undefined;
}

export function chatMessage(stored: StoredMessage): ChatMessage {
  const meta = stored.meta ?? {};
  const pick = meta.pick as { by?: unknown; why?: unknown } | undefined;
  const notice = meta.notice as { mono?: unknown; retry?: unknown } | undefined;
  const reactions = reactionsOf(stored.reactions ?? {});
  const attachments = attachmentsOf(meta.attachments);
  return {
    id: stored.id,
    from: stored.author,
    text: stored.text,
    kind: stored.kind,
    at: stored.createdAt,
    ...(stored.replyTo ? { replyTo: stored.replyTo } : {}),
    ...(reactions ? { reactions } : {}),
    ...(meta.quiet === true ? { quiet: true } : {}),
    ...(typeof meta.refId === "string" ? { refId: meta.refId } : {}),
    ...(typeof meta.status === "string" ? { status: meta.status as ChatMessage["status"] } : {}),
    ...(pick && typeof pick.by === "string" && PICKS.has(pick.by) && typeof pick.why === "string"
      ? { pick: { by: pick.by as NonNullable<ChatMessage["pick"]>["by"], why: pick.why } }
      : {}),
    ...(notice && typeof notice === "object"
      ? { notice: { ...(typeof notice.mono === "string" ? { mono: notice.mono } : {}), ...(notice.retry === true ? { retry: true } : {}) } }
      : {}),
    ...(typeof meta.gather === "string" && meta.gather ? { gather: meta.gather } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/** A council row that is not the shape is dropped: the room opens with no council. */
function councilOn(json: string | undefined): GroupChat["council"] {
  if (!json) return undefined;
  try {
    return councilFromUnknown(JSON.parse(json)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function groupChats(snapshot: RoomSnapshot, now = Date.now()): GroupChat[] {
  return snapshot.rooms.map((room) => {
    const council = councilOn(room.councilJson);
    return {
    id: room.id,
    projectId: room.projectId,
    name: room.name,
    isDefault: room.isDefault,
    memberIds: [...room.memberIds],
    ...(room.leadId ? { leadId: room.leadId } : {}),
    ...(isResponderMode(room.responder) ? { responder: room.responder } : {}),
    ...(council ? { council } : {}),
    ...(room.seated ? { seated: true } : {}),
    conversations: room.conversations.map((c) => ({
      id: c.id,
      when: whenLabel(c.createdAt, now),
      title: c.title,
      ...(c.named ? { named: true } : {}),
      ...(c.answeredThrough ? { answeredThrough: c.answeredThrough } : {}),
      createdAt: c.createdAt,
      ...(c.more ? { more: true } : {}),
      messages: c.messages.map(chatMessage),
    })),
    };
  });
}

/**
 * The old key's rooms as an import: every message keeps its id, and each conversation and message gets the time its id
 * carries, else one just before the next (so the order holds). Conversations are newest first in the old key.
 */
export function legacyBundle(chats: readonly GroupChat[], seated: ReadonlySet<string>, now = Date.now()): ImportBundle {
  const bundle: ImportBundle = { rooms: [], conversations: [], messages: [] };
  chats.forEach((chat, chatIndex) => {
    bundle.rooms.push({ ...roomInput(chat), seated: seated.has(chat.id) || !!chat.seated, createdAt: now - (chats.length - chatIndex) * 1000 });
    // Newest first: one without a time of its own gets one just older than the conversation above it.
    let above = now;
    chat.conversations.forEach((conversation) => {
      const firstAt = conversation.messages.map((m) => m.at ?? timeInId(m.id)).find((t) => t !== undefined);
      const known = conversation.createdAt ?? timeInId(conversation.id) ?? firstAt;
      const createdAt = known !== undefined && known < above ? known : above - 60_000;
      above = createdAt;
      bundle.conversations.push({ ...conversationInput(chat.id, conversation), createdAt });
      let previous = createdAt;
      conversation.messages.forEach((message) => {
        const known = message.at ?? timeInId(message.id);
        const time = known !== undefined && known >= previous ? known : previous + 1;
        previous = time;
        bundle.messages.push({ ...messageInput(chat.id, conversation.id, message), createdAt: time });
      });
    });
  });
  return bundle;
}

/** A short fingerprint of a string (the old key's contents), to tell whether it changed since the last copy. */
export function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Every room, conversation and message of the import is in `snapshot` (each conversation's newest STORED_MESSAGES:
 * the old key never held more). Returns what is missing, in plain words, or nothing.
 */
export function missingAfterImport(bundle: ImportBundle, snapshot: RoomSnapshot): string | undefined {
  const rooms = new Map(snapshot.rooms.map((room) => [room.id, room]));
  let missing = 0;
  for (const room of bundle.rooms) if (!rooms.has(room.id)) missing++;
  for (const conversation of bundle.conversations)
    if (!rooms.get(conversation.roomId)?.conversations.some((c) => c.id === conversation.id)) missing++;
  for (const message of bundle.messages) {
    const conversation = rooms.get(message.roomId)?.conversations.find((c) => c.id === message.conversationId);
    if (!conversation) continue; // counted above
    if (!conversation.more && !conversation.messages.some((m) => m.id === message.id)) missing++;
  }
  return missing ? `${missing} item${missing === 1 ? "" : "s"} of the old group chats didn't come across` : undefined;
}
