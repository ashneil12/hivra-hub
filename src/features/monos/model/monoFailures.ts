// The Monos whose last turn failed (turnFailure.ts), for the places Ash looks besides the chat: the Monos rail, Today
// and Being built. The app reports its chats here as they change (`noteMonoFailures`) and lends its hands
// (`setMonoFailuresHost`): Try again and Open. Dismiss sets one failure aside on Today and Being built (remembered by its
// notice, so a new failure shows again); the rail and the chat keep saying it until the Mono's next turn.
import { useSyncExternalStore } from "react";
import type { Session } from "../../sessions/model/session";
import { findMono, listMonos, monoLook } from "./mono";
import { lastTurnFailure, type TurnFailure } from "./turnFailure";

export type MonoFailure = TurnFailure & {
  monoId: string;
  sessionId: string;
};

export type MonoFailuresHost = {
  /** Try the failed turn again: Ash's held message if one waits, else the turn carries on. False when it can't now. */
  retry(sessionId: string): boolean;
  /** Show the Mono's chat. */
  open(monoId: string): void;
};

type ChatInput = Pick<Session, "id" | "blocks" | "busy" | "usageLimit" | "worktreeRemoved">;

const DISMISSED_KEY = "monocode:mono-failures-dismissed";

let failures = new Map<string, MonoFailure>();
let dismissed: Set<string> | undefined;
let host: MonoFailuresHost | undefined;
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function dismissedSet(): Set<string> {
  if (dismissed) return dismissed;
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    dismissed = new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
  } catch {
    dismissed = new Set();
  }
  return dismissed;
}

const keyOf = (failure: Pick<MonoFailure, "sessionId" | "blockId">) => `${failure.sessionId}#${failure.blockId}`;
const same = (a: MonoFailure | undefined, b: MonoFailure | undefined) =>
  a?.blockId === b?.blockId && a?.reason === b?.reason && a?.tone === b?.tone;

// The app reports its chats on every change (each streamed word): a chat whose transcript and state are the same
// objects as last time is not read again.
const reads = new WeakMap<object, { busy: boolean; limit: unknown; removed: boolean; failure: TurnFailure | undefined }>();
function read(chat: ChatInput): TurnFailure | undefined {
  const seen = reads.get(chat.blocks);
  if (seen && seen.busy === !!chat.busy && seen.limit === chat.usageLimit && seen.removed === !!chat.worktreeRemoved)
    return seen.failure;
  const failure = lastTurnFailure(chat);
  reads.set(chat.blocks, { busy: !!chat.busy, limit: chat.usageLimit, removed: !!chat.worktreeRemoved, failure });
  return failure;
}

/** The app's chats as they are now: every Mono's own chat is read for a failed last turn. */
export function noteMonoFailures(chats: readonly ChatInput[]): void {
  const next = new Map<string, MonoFailure>();
  // The roster once per call (it is read from storage): this runs on every change to any chat.
  const monoOf = new Map(listMonos().flatMap((mono) => (mono.sessionId ? [[mono.sessionId, mono] as const] : [])));
  for (const chat of chats) {
    const mono = monoOf.get(chat.id);
    if (!mono) continue;
    const failure = read(chat);
    if (failure) next.set(mono.id, { ...failure, monoId: mono.id, sessionId: chat.id });
  }
  const changed = next.size !== failures.size || [...next].some(([id, failure]) => !same(failure, failures.get(id)));
  failures = next;
  if (changed) bump();
}

/** Every Mono whose last turn failed and Ash hasn't set aside, oldest first. */
export function monoFailures(): MonoFailure[] {
  const hidden = dismissedSet();
  return [...failures.values()].filter((failure) => !hidden.has(keyOf(failure))).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

/** This Mono's failed last turn, set aside or not (the rail keeps showing it). */
export function monoFailure(monoId: string): MonoFailure | undefined {
  return failures.get(monoId);
}

/** "Tally lead". */
export function failedMonoName(failure: Pick<MonoFailure, "monoId">): string {
  const mono = findMono(failure.monoId);
  return mono ? monoLook(mono).name : "A Mono";
}

/** Try again: false when the app's hands aren't here or the chat can't take it now. */
export function retryMonoFailure(monoId: string): boolean {
  const failure = failures.get(monoId);
  if (!failure || !host) return false;
  return host.retry(failure.sessionId);
}

export function openMonoFailure(monoId: string): void {
  host?.open(monoId);
}

/** Ash has seen it: it leaves Today and Being built (the chat and the rail still say it until the next turn). */
export function dismissMonoFailure(monoId: string): void {
  const failure = failures.get(monoId);
  if (!failure) return;
  const hidden = dismissedSet();
  hidden.add(keyOf(failure));
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...hidden].slice(-200)));
  } catch {
    /* without storage it stays set aside until the app restarts */
  }
  bump();
}

/** The app lends its hands; the returned function takes them back. */
export function setMonoFailuresHost(next: MonoFailuresHost): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

export function subscribeMonoFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render when a Mono fails or recovers. */
export function useMonoFailuresVersion(): number {
  return useSyncExternalStore(subscribeMonoFailures, () => version, () => version);
}

/** Tests: forget everything. */
export function resetMonoFailures(): void {
  failures = new Map();
  dismissed = undefined;
  host = undefined;
  bump();
}
