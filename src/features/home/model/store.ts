// Home's arrangement and the chats the person opened. The app's own store is the record.
// The same JSON is mirrored to a portable setting, because an export carries settings and not hub documents.
// A write lands only on the revision just read. A timeout is not a saved failure and not an empty home.

import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { parseArrangement, type HomeArrangement } from "./arrangement";
import { parseChat, type HomeChat } from "./lines";

export const HOME_DOC_KEY = "home";
export const HOME_SETTING_KEY = "monocode:home";

const TRIES = 5;
const NOTE_TRIES = 4;
const NOTE_WAIT_MS = 2000;
const CHAT_CAP = 20;

/** The store did not answer. Not an empty home. */
export class HomeStoreUnavailable extends Error {
  constructor() {
    super("unavailable");
    this.name = "HomeStoreUnavailable";
  }
}

export type HomeDoc = {
  arrangement: HomeArrangement;
  recent: HomeChat[];
  savedAt: number;
};

export type HomeStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export function browserStorage(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): HomeStorage {
  return {
    get(key) {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        /* the hub document is the record; the mirror is best effort */
      }
    },
  };
}

export function emptyHomeDoc(): HomeDoc {
  return { arrangement: parseArrangement(null), recent: [], savedAt: 0 };
}

export function parseHomeDoc(raw: unknown): HomeDoc {
  if (!raw || typeof raw !== "object") return emptyHomeDoc();
  const rec = raw as Record<string, unknown>;
  const arrangement = parseArrangement(rec.arrangement);
  const recent: HomeChat[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.recent)) {
    for (const item of rec.recent) {
      const chat = parseChat(item);
      if (!chat || seen.has(chat.id)) continue;
      seen.add(chat.id);
      recent.push(chat);
      if (recent.length >= CHAT_CAP) break;
    }
  }
  const savedAt = typeof rec.savedAt === "number" && Number.isFinite(rec.savedAt) ? rec.savedAt : arrangement.savedAt;
  return { arrangement, recent, savedAt };
}

export function withChat(doc: HomeDoc, chat: HomeChat): HomeDoc {
  const parsed = parseChat(chat);
  if (!parsed) return doc;
  return { ...doc, recent: [parsed, ...doc.recent.filter((item) => item.id !== parsed.id)].slice(0, CHAT_CAP) };
}

function stamp(doc: HomeDoc, now: number): HomeDoc {
  return {
    arrangement: { ...doc.arrangement, savedAt: now },
    recent: doc.recent,
    savedAt: now,
  };
}

function sameBody(a: HomeDoc, b: HomeDoc): boolean {
  return JSON.stringify({ arrangement: { order: a.arrangement.order, hidden: a.arrangement.hidden }, recent: a.recent })
    === JSON.stringify({ arrangement: { order: b.arrangement.order, hidden: b.arrangement.hidden }, recent: b.recent });
}

function mirrorOf(storage: HomeStorage): HomeDoc | null {
  const raw = storage.get(HOME_SETTING_KEY);
  if (!raw) return null;
  try {
    return parseHomeDoc(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function remember(storage: HomeStorage, doc: HomeDoc): void {
  try {
    storage.set(HOME_SETTING_KEY, JSON.stringify(doc));
  } catch {
    /* the hub document is the record; a mirror that cannot be saved changes nothing there */
  }
}

/**
 * Read, change, write on that revision. A null write is another window: read again and apply on top.
 * A timeout is tried again. After the tries, nothing is written and the caller keeps what it showed.
 */
export async function changeHome(
  disk: LocalHubDisk,
  storage: HomeStorage,
  fn: (doc: HomeDoc) => HomeDoc,
  now: () => number = Date.now,
): Promise<{ doc: HomeDoc; rev: number } | null> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    let current: { value: unknown; rev: number };
    try {
      current = await disk.readDoc(HOME_DOC_KEY);
    } catch {
      // A timeout is not a final failure. Try the read again.
      continue;
    }
    const base = parseHomeDoc(current.value);
    let next: HomeDoc;
    try {
      next = fn(base);
    } catch {
      return null;
    }
    if (sameBody(base, next)) return { doc: base, rev: current.rev };
    const stamped = stamp(parseHomeDoc(next), now());
    let rev: number | null;
    try {
      rev = await disk.write(HOME_DOC_KEY, stamped, current.rev);
    } catch {
      // A timeout is not a saved failure. Try again on a fresh read.
      continue;
    }
    if (rev == null) continue;
    remember(storage, stamped);
    return { doc: stamped, rev };
  }
  return null;
}

/**
 * The hub document, unless the portable mirror is newer (an import wrote the setting and not the document).
 * Adopting the mirror uses the same revision check, so a window that wrote since the read is not overwritten.
 */
export async function readHome(
  disk: LocalHubDisk,
  storage: HomeStorage,
  now: () => number = Date.now,
): Promise<{ doc: HomeDoc; rev: number; unavailable: boolean }> {
  let current: { value: unknown; rev: number };
  try {
    current = await disk.readDoc(HOME_DOC_KEY);
  } catch {
    // A timeout is not an empty home. The mirror is what we can still show, and the caller tries the store again.
    const mirror = mirrorOf(storage);
    if (mirror && mirror.savedAt > 0) return { doc: mirror, rev: 0, unavailable: true };
    throw new HomeStoreUnavailable();
  }
  const doc = parseHomeDoc(current.value);
  const mirror = mirrorOf(storage);
  if (!mirror || mirror.savedAt <= doc.savedAt) return { doc, rev: current.rev, unavailable: false };
  for (let attempt = 0; attempt < TRIES; attempt++) {
    let latest: { value: unknown; rev: number };
    try {
      latest = await disk.readDoc(HOME_DOC_KEY);
    } catch {
      return { doc, rev: current.rev, unavailable: true };
    }
    const parsed = parseHomeDoc(latest.value);
    if (mirror.savedAt <= parsed.savedAt) return { doc: parsed, rev: latest.rev, unavailable: false };
    const stamped = stamp(mirror, now());
    let rev: number | null;
    try {
      rev = await disk.write(HOME_DOC_KEY, stamped, latest.rev);
    } catch {
      return { doc, rev: current.rev, unavailable: true };
    }
    if (rev == null) continue;
    remember(storage, stamped);
    return { doc: stamped, rev, unavailable: false };
  }
  return { doc, rev: current.rev, unavailable: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Remember a chat the person opened. A timeout is tried again. A failure leaves Recent as it was. */
export async function noteOpenedChat(
  chat: HomeChat,
  disk: LocalHubDisk = tauriLocalHubDisk,
  storage: HomeStorage = browserStorage(),
  wait: (ms: number) => Promise<void> = delay,
): Promise<{ doc: HomeDoc; rev: number } | null> {
  for (let attempt = 0; attempt < NOTE_TRIES; attempt++) {
    const written = await changeHome(disk, storage, (doc) => withChat(doc, chat)).catch(() => null);
    if (written) return written;
    if (attempt + 1 < NOTE_TRIES) await wait(NOTE_WAIT_MS);
  }
  return null;
}
