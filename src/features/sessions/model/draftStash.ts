// WP-124: one stashed draft per chat, in local storage, so a reload can put it back. The draft cache is memory only
// and does not survive a reload. Values read back are untrusted and dropped when they are not a draft.

import type { Attachment, AttachmentKind } from "./session";

export const STASH_STORAGE_KEY = "monocode.composerStash.v1";
export const STASH_EVENT = "monocode:composer-stash";

const KINDS = new Set<AttachmentKind>(["image", "audio", "file"]);

export type StashedAttachment = {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  path?: string;
  data?: string;
};

export type StashedDraft = {
  text: string;
  attachments: StashedAttachment[];
  savedAt: number;
};

export type StashResult = { ok: true } | { ok: false; reason: "empty" | "save" };

type Store = Record<string, StashedDraft>;

function storageOf(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STASH_EVENT));
}

function isSessionId(id: string): boolean {
  return id.length > 0 && !id.includes("\0");
}

function attachmentOf(value: unknown): StashedAttachment | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Record<string, unknown>;
  if (typeof file.name !== "string" || file.name.length === 0) return null;
  if (typeof file.mimeType !== "string") return null;
  if (typeof file.kind !== "string" || !KINDS.has(file.kind as AttachmentKind)) return null;
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) return null;
  const path = typeof file.path === "string" && file.path.length > 0 ? file.path : undefined;
  const data = typeof file.data === "string" && file.data.length > 0 ? file.data : undefined;
  return {
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind as AttachmentKind,
    size: file.size,
    ...(path ? { path } : {}),
    ...(data ? { data } : {}),
  };
}

function draftOf(value: unknown): StashedDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.text !== "string") return null;
  if (!Array.isArray(draft.attachments)) return null;
  if (typeof draft.savedAt !== "number" || !Number.isFinite(draft.savedAt)) return null;
  const attachments = draft.attachments.map(attachmentOf).filter((file) => file !== null);
  if (attachments.length !== draft.attachments.length) return null;
  if (draft.text.trim().length === 0 && attachments.length === 0) return null;
  return { text: draft.text, attachments, savedAt: draft.savedAt };
}

function readStore(storage: Storage): Store {
  let parsed: unknown;
  try {
    const raw = storage.getItem(STASH_STORAGE_KEY);
    if (!raw) return Object.create(null);
    parsed = JSON.parse(raw);
  } catch {
    return Object.create(null);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null);
  const store: Store = Object.create(null);
  for (const [id, value] of Object.entries(parsed)) {
    if (!isSessionId(id)) continue;
    const draft = draftOf(value);
    if (draft) store[id] = draft;
  }
  return store;
}

function writeStore(storage: Storage, store: Store): boolean {
  try {
    storage.setItem(STASH_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** Save the draft and replace whatever this chat had stashed. An empty draft is refused. */
export function stashDraft(
  sessionId: string,
  text: string,
  attachments: readonly Attachment[],
  storage?: Storage,
  now = Date.now(),
): StashResult {
  const box = storageOf(storage);
  if (!box || !isSessionId(sessionId)) return { ok: false, reason: "save" };
  const kept = attachments
    .map((file) =>
      attachmentOf({
        name: file.name,
        mimeType: file.mimeType,
        kind: file.kind,
        size: file.size,
        path: file.path,
        data: file.data,
      }),
    )
    .filter((file) => file !== null);
  if (text.trim().length === 0 && kept.length === 0) return { ok: false, reason: "empty" };
  const store = readStore(box);
  const previous = store[sessionId];
  store[sessionId] = { text, attachments: kept, savedAt: now };
  if (!writeStore(box, store)) {
    if (previous) store[sessionId] = previous;
    else delete store[sessionId];
    return { ok: false, reason: "save" };
  }
  notify();
  return { ok: true };
}

/** The stashed draft, or null. Does not remove it. */
export function peekStash(sessionId: string, storage?: Storage): StashedDraft | null {
  const box = storageOf(storage);
  if (!box || !isSessionId(sessionId)) return null;
  return readStore(box)[sessionId] ?? null;
}

/** True when the composer is empty, so a restore will not throw away what is typed. */
export function canRestoreStash(text: string, attachments: readonly { id: string }[]): boolean {
  return text.trim().length === 0 && attachments.length === 0;
}

/** Attachments for the composer. New ids, no preview URL. Object URLs do not survive a reload. */
export function restoreAttachments(
  draft: StashedDraft,
  idFor: (index: number) => string = (index) => `stash-${draft.savedAt}-${index}`,
): Attachment[] {
  return draft.attachments.map((file, index) => ({
    id: idFor(index),
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind,
    size: file.size,
    ...(file.path ? { path: file.path } : {}),
    ...(file.data ? { data: file.data } : {}),
  }));
}

export type StashShortcut = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/** Cmd/Ctrl+Shift+S. The physical S key counts, so a non-Latin layout still matches. */
export function isStashShortcut(event: StashShortcut): boolean {
  if (event.altKey || !event.shiftKey || (!event.metaKey && !event.ctrlKey)) return false;
  if (event.code) return event.code === "KeyS";
  return (event.key ?? "").toLowerCase() === "s";
}
