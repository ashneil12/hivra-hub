// This machine's settle and snooze marks. A failed read or write is not final:
// the next change tries again, and two windows merge by touch instead of
// overwriting the whole document.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  applyInbox,
  chatAttention,
  EMPTY_INBOX,
  formatSnoozeWhen,
  inboxNoticeCopy,
  INBOX_STATE_KEY,
  mergeInbox,
  parseInboxDoc,
  stripInbox,
  storedMarksEqual,
  type AttentionBlock,
  type ChatAttention,
  type InboxCommand,
  type InboxDoc,
  type InboxMark,
} from "./chatListInbox";
import type { Session } from "./session";

export const EMPTY_CHAT_LIST_SESSIONS: readonly never[] = [];

export type InboxNotice = {
  text: string;
  sr: string;
  undoMarks: Record<string, InboxMark | undefined>;
};

type NoticeCommand = "settle" | "unsettle" | "snooze" | "unsnooze";

let snapshot: InboxDoc = EMPTY_INBOX;
let pending: InboxDoc | null = null;
let notice: InboxNotice | null = null;
let storageListening = false;
const docListeners = new Set<() => void>();
const noticeListeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(INBOX_STATE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(raw: string): boolean {
  try {
    localStorage.setItem(INBOX_STATE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

function remember(doc: InboxDoc) {
  snapshot = doc;
  for (const listener of docListeners) listener();
}

function rememberNotice(next: InboxNotice | null) {
  notice = next;
  for (const listener of noticeListeners) listener();
}

function loadMerged(): { raw: string | null; doc: InboxDoc } {
  const raw = readRaw();
  const parsed = parseInboxDoc(raw);
  if (!pending) return { raw, doc: parsed };
  const merged = stripInbox(mergeInbox(EMPTY_INBOX, pending, parsed));
  return { raw, doc: { rev: Math.max(parsed.rev, pending.rev, merged.rev), chats: merged.chats } };
}

function ensureStorageListener() {
  if (storageListening || typeof window === "undefined") return;
  storageListening = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== INBOX_STATE_KEY) return;
    const parsed = parseInboxDoc(readRaw());
    if (pending) {
      const merged = stripInbox(mergeInbox(EMPTY_INBOX, pending, parsed));
      pending = { rev: Math.max(parsed.rev, pending.rev), chats: merged.chats };
      remember(pending);
      return;
    }
    remember(parsed);
  });
}

export function subscribeInbox(listener: () => void): () => void {
  ensureStorageListener();
  docListeners.add(listener);
  return () => docListeners.delete(listener);
}

export function getInboxSnapshot(): InboxDoc {
  return snapshot;
}

export function useInboxDoc(): InboxDoc {
  return useSyncExternalStore(subscribeInbox, getInboxSnapshot, getInboxSnapshot);
}

function subscribeNotice(listener: () => void): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

export function inboxNoticeSnapshot(): InboxNotice | null {
  return notice;
}

export function useInboxNotice(): InboxNotice | null {
  return useSyncExternalStore(subscribeNotice, inboxNoticeSnapshot, inboxNoticeSnapshot);
}

function commit(ids: readonly string[], command: InboxCommand): {
  doc: InboxDoc;
  changedIds: string[];
  undoMarks: Record<string, InboxMark | undefined>;
} {
  const started = loadMerged();
  const applied = applyInbox(started.doc, ids, command);
  let ours = applied.doc;
  let seenRaw = started.raw;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentRaw = readRaw();
    if (currentRaw !== seenRaw) {
      ours = mergeInbox(started.doc, ours, parseInboxDoc(currentRaw));
      seenRaw = currentRaw;
      continue;
    }
    const seen = parseInboxDoc(seenRaw);
    const stored = stripInbox(ours);
    const changedIds = Object.keys(applied.previous).filter((id) => !storedMarksEqual(seen.chats[id], stored.chats[id]));
    const undoMarks: Record<string, InboxMark | undefined> = {};
    for (const id of changedIds) undoMarks[id] = seen.chats[id];
    if (changedIds.length === 0) {
      if (JSON.stringify(stored.chats) !== JSON.stringify(seen.chats)) {
        pending = { rev: seen.rev, chats: stored.chats };
        remember(pending);
        return { doc: pending, changedIds, undoMarks };
      }
      pending = null;
      remember(seen);
      return { doc: seen, changedIds, undoMarks };
    }
    const next: InboxDoc = { rev: seen.rev + 1, chats: stored.chats };
    const raw = JSON.stringify(next);
    if (!writeRaw(raw)) {
      pending = next;
      remember(next);
      return { doc: next, changedIds, undoMarks };
    }
    let confirmed: string | null;
    try {
      confirmed = localStorage.getItem(INBOX_STATE_KEY);
    } catch {
      pending = next;
      remember(next);
      return { doc: next, changedIds, undoMarks };
    }
    if (confirmed !== raw) {
      ours = mergeInbox(started.doc, ours, parseInboxDoc(confirmed));
      seenRaw = confirmed;
      continue;
    }
    pending = null;
    remember(next);
    return { doc: next, changedIds, undoMarks };
  }
  const current = loadMerged().doc;
  remember(current);
  return { doc: current, changedIds: [], undoMarks: {} };
}

function run(ids: readonly string[], command: InboxCommand, noticeCommand: NoticeCommand, untilLabel?: string) {
  const result = commit(ids, command);
  if (result.changedIds.length === 0) return result.doc;
  rememberNotice({
    ...inboxNoticeCopy(noticeCommand, result.changedIds.length, untilLabel),
    undoMarks: result.undoMarks,
  });
  return result.doc;
}

export function settleChats(ids: readonly string[], at = Date.now()): InboxDoc {
  return run(ids, { type: "settle", at }, "settle");
}

export function unsettleChats(ids: readonly string[], at = Date.now()): InboxDoc {
  return run(ids, { type: "unsettle", at }, "unsettle");
}

export function snoozeChats(ids: readonly string[], until: number, at = Date.now()): InboxDoc {
  return run(ids, { type: "snooze", at, until }, "snooze", formatSnoozeWhen(until, at));
}

export function unsnoozeChats(ids: readonly string[], at = Date.now()): InboxDoc {
  return run(ids, { type: "unsnooze", at }, "unsnooze");
}

export function undoInbox(at = Date.now()): InboxDoc | null {
  if (!notice) return null;
  const marks = notice.undoMarks;
  rememberNotice(null);
  return commit(Object.keys(marks), { type: "restore", at, marks }).doc;
}

export function useInboxNow(enabled: boolean): number {
  const doc = useInboxDoc();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const arm = () => {
      const nextNow = Date.now();
      setNow(nextNow);
      let soonest = nextNow + 30_000;
      for (const mark of Object.values(doc.chats)) {
        const until = mark?.snoozeUntil;
        if (until != null && until > nextNow && until < soonest) soonest = until;
      }
      const delay = Math.min(30_000, Math.max(250, soonest - Date.now()));
      timer = window.setTimeout(arm, delay);
    };
    const onFocus = () => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    timer = window.setTimeout(arm, 250);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, doc]);
  return now;
}

export function useChatListAttention(
  sessions: readonly {
    id: string;
    busy?: boolean;
    worktreeRemoved?: boolean;
    usageLimit?: Session["usageLimit"];
    pendingQuestion?: unknown;
    blocks: readonly AttentionBlock[];
  }[],
): ReadonlyMap<string, ChatAttention> {
  return useMemo(() => {
    const map = new Map<string, ChatAttention>();
    for (const session of sessions) {
      if (!session.id) continue;
      map.set(session.id, chatAttention(session));
    }
    return map;
  }, [sessions]);
}

snapshot = parseInboxDoc(readRaw());
ensureStorageListener();

/** Test hook: drop the in-memory copy so the next read comes from storage. */
export function resetInboxStoreForTests(): void {
  pending = null;
  notice = null;
  snapshot = EMPTY_INBOX;
  try {
    localStorage.removeItem(INBOX_STATE_KEY);
  } catch {
    // Storage can be unavailable. The in-memory copy is already empty.
  }
  remember(EMPTY_INBOX);
  rememberNotice(null);
}

export function reloadInboxFromStorage(): void {
  remember(loadMerged().doc);
}
