// A chat's sub-chats in a team's Sessions list (a project's coding team or a Mono's own team; never the Monos rail),
// like Claude Code's grouped sessions but usually hidden (Ash, 20 Oct): folded under a count ("3 sub-chats") unless Ash
// opened them, opened by themselves when one is stuck, asking or failed, and six at a time with "Show N more". The fold
// is remembered per chat on this Mac. Folding a chat whose sub-chats opened for a stuck one keeps it folded until
// something else gets stuck. A Mono's own row reads its stuck mark from the same attention (MonoRailSection.tsx).
import { useSyncExternalStore } from "react";
import type { ChildChat } from "./delegationView";
import { stuckOf, type StuckWorker } from "./workerStuck";

export const SUB_CHATS_SHOWN = 6;
const KEY = "monocode:mono-sub-chats";

type Fold = { open?: boolean; seen?: string };

let folds: Record<string, Fold> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function load(): Record<string, Fold> {
  if (folds) return folds;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    folds = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Fold>) : {};
  } catch {
    folds = {};
  }
  return folds;
}

function save(monoId: string, fold: Fold) {
  folds = { ...load(), [monoId]: fold };
  try {
    localStorage.setItem(KEY, JSON.stringify(folds));
  } catch {
    /* remembered until the app restarts */
  }
  version++;
  listeners.forEach((listener) => listener());
}

export function useSubChatFolds(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests: forget every fold. */
export function resetSubChatFolds(): void {
  folds = undefined;
  version++;
}

/** A Mono's sub-chats as the rail reads them: which are stuck, and the signature of that set. */
export function subChatAttention(children: readonly ChildChat[], now: number): { stuck: Map<string, StuckWorker>; key: string } {
  const stuck = new Map<string, StuckWorker>();
  for (const chat of children) {
    const found = chat.row ? stuckOf(chat.row, now) : undefined;
    if (found) stuck.set(chat.sessionId, found);
  }
  return { stuck, key: [...stuck.values()].map((s) => s.key).sort().join("|") };
}

/** Open: Ash opened it, or something is stuck that he hasn't folded away yet. */
export function subChatsOpen(monoId: string, attentionKey: string): boolean {
  const fold = load()[monoId] ?? {};
  return fold.open === true || (!!attentionKey && attentionKey !== fold.seen);
}

/** Ash's click on the fold: folding records what was stuck then, so only something new opens it again. */
export function toggleSubChats(monoId: string, attentionKey: string): void {
  if (subChatsOpen(monoId, attentionKey)) save(monoId, { open: false, ...(attentionKey ? { seen: attentionKey } : {}) });
  else save(monoId, { open: true });
}

/** The sub-chats shown: the first six in order, always with every stuck one; the rest behind "Show N more". */
export function shownSubChats(
  children: readonly ChildChat[],
  stuck: ReadonlyMap<string, unknown>,
  all: boolean,
): { shown: ChildChat[]; more: number } {
  if (all || children.length <= SUB_CHATS_SHOWN) return { shown: [...children], more: 0 };
  const keep = new Set(children.filter((chat) => stuck.has(chat.sessionId)).map((chat) => chat.sessionId));
  for (const chat of children) {
    if (keep.size >= SUB_CHATS_SHOWN) break;
    keep.add(chat.sessionId);
  }
  const shown = children.filter((chat) => keep.has(chat.sessionId));
  return { shown, more: children.length - shown.length };
}
