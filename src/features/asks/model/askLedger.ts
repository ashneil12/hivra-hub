// MOCK-UP BRANCH (one main Chief of Staff chat, 13 Nov): "You asked", the list of everything the owner asked for,
// kept outside the chat so a long conversation can't lose an ask. Example data only; nothing here is wired to a store
// the native side knows. Also holds which of the four directions the mock-up shows.
import { useSyncExternalStore } from "react";

export type AskedState = "working" | "done" | "waiting" | "unclear";
export type Asked = { id: string; text: string; where: string; state: AskedState };
export type Direction = "a" | "b" | "c" | "d";

const KEY = "monocode:mockup-asked";
const DIR_KEY = "monocode:mockup-direction";
const listeners = new Set<() => void>();
let cache: { raw: string | null; list: Asked[] } = { raw: "", list: [] };

function read(): Asked[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cache.raw) return cache.list;
  let list: Asked[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed as Asked[];
  } catch {
    list = [];
  }
  cache = { raw, list };
  return list;
}

function changed(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAsked(list: readonly Asked[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    return;
  }
  changed();
}

export function addAsked(items: readonly Asked[]): void {
  const have = new Set(read().map((item) => item.id));
  setAsked([...read(), ...items.filter((item) => !have.has(item.id))]);
}

export function useAsked(): readonly Asked[] {
  return useSyncExternalStore(subscribe, read, read);
}

export const ASKED_WORD: Record<AskedState, string> = {
  working: "Working",
  done: "Done, checked against your words",
  waiting: "Waiting on purpose",
  unclear: "Unclear, the Chief of Staff will ask you",
};

function readDirection(): Direction {
  try {
    const value = localStorage.getItem(DIR_KEY);
    if (value === "a" || value === "b" || value === "c" || value === "d") return value;
  } catch {
    return "c";
  }
  return "c";
}

export function setDirection(direction: Direction): void {
  try {
    localStorage.setItem(DIR_KEY, direction);
  } catch {
    return;
  }
  changed();
}

export function useDirection(): Direction {
  return useSyncExternalStore(subscribe, readDirection, readDirection);
}
