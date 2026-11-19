// What the person just answered from a Needs you card (Ash, 13 Nov: "the animation for it can be better"). The row
// leaves the list as soon as the asker has the answer, so the card would vanish mid-tap; this keeps the answer for a
// short while, so the place it was answered says "Answered: Take A. EXO lead has it." instead of going blank.
import { useSyncExternalStore } from "react";

/** How long an answer is remembered for the line that replaces its card. */
export const ANSWERED_SHOWN_MS = 8_000;

export type AnsweredNeed = { key: string; words: string; who: string; sentence: string; at: number; /** What the card says in place of "Answered: <words>. <who> has it." (a quiet ask's own answers). */ line?: string };

let last: AnsweredNeed | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function noteAnswered(entry: Omit<AnsweredNeed, "at">, now = Date.now()): void {
  last = { ...entry, at: now };
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    last = undefined;
    emit();
  }, ANSWERED_SHOWN_MS);
  emit();
}

/** The last answer, while it is still shown. With `key`, only that row's. */
export function lastAnswered(key?: string): AnsweredNeed | undefined {
  if (!last) return undefined;
  return key === undefined || last.key === key ? last : undefined;
}

export function resetAnswered(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  last = undefined;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastAnswered(key?: string): AnsweredNeed | undefined {
  return useSyncExternalStore(subscribe, () => lastAnswered(key), () => undefined);
}

/** "Answered: Take A. EXO lead has it." */
export function answeredLine(entry: Pick<AnsweredNeed, "words" | "who"> & { line?: string }): string {
  if (entry.line) return entry.line;
  const words = entry.words.replace(/\s+/g, " ").trim();
  const short = words.length > 80 ? `${words.slice(0, 79).trimEnd()}…` : words;
  return `Answered: ${short}${/[.!?…]$/.test(short) ? "" : "."} ${entry.who} has it.`;
}
