// WP-144: what the app binds so a held brief can start and the person can be asked. The brief itself (the delegate call)
// is kept in the review record (store.ts), so it outlives a restart and a closed window. This file holds the ways the
// app starts it again and reaches the Inbox and the chat that asked, and the guard against starting it twice here.

import type { AskInput } from "../../firstmate/model/steering";

export type HeldStarter = {
  /** The chat that asked is loaded in this window, so the brief can go back to it. */
  canStart(owner: string): boolean;
  /** Ask tasks.delegate again under the same request ID, the way a waiting worker's start does. */
  start(owner: string, requestId: string, input: Record<string, unknown>): Promise<unknown>;
};

/** The decisions the Inbox keeps, as the review reads them. */
export type EyesDecision = {
  project: string;
  decisionKey: string;
  answer: string | null;
  state: string;
  answeredBy: string | null;
};

/** What the review needs from the app's Inbox and from the chat that asked (App.tsx binds it; tests pass a fake). */
export type FreshEyesBackend = {
  ask(input: AskInput): Promise<unknown>;
  answer(project: string, key: string, answer: string, by?: string): Promise<unknown>;
  decisions(): Promise<EyesDecision[]>;
  /** Put a note into the chat that asked, as its own turn. */
  tell(owner: string, requestId: string, text: string): Promise<unknown>;
};

let starter: HeldStarter | undefined;
let backend: FreshEyesBackend | undefined;

/** The app binds this once. It returns the unbind. */
export function bindHeldStarter(next: HeldStarter): () => void {
  starter = next;
  return () => {
    if (starter === next) starter = undefined;
  };
}

export function heldStarter(): HeldStarter | undefined {
  return starter;
}

export function bindFreshEyesBackend(next: FreshEyesBackend): () => void {
  backend = next;
  return () => {
    if (backend === next) backend = undefined;
  };
}

export function freshEyesBackend(): FreshEyesBackend | undefined {
  return backend;
}

const starting = new Set<string>();
const reviewing = new Set<string>();

type Ref = { project: string; requestId: string; owner?: string };

/** The guards are per window: `windowId` is the store's, so two stores in a test are two windows. */
function keyFor(windowId: string, ref: Ref): string {
  return `${windowId}\n${ref.project}\n${ref.owner ?? ""}\n${ref.requestId}`;
}

/** True once, and only while no start of this brief is running in this window. */
export function beginStart(windowId: string, ref: Ref): boolean {
  const key = keyFor(windowId, ref);
  if (starting.has(key)) return false;
  starting.add(key);
  return true;
}

export function endStart(windowId: string, ref: Ref): void {
  starting.delete(keyFor(windowId, ref));
}

/** True once, and only while this window is not already running the reviewers for it. */
export function beginReviewing(windowId: string, ref: Ref): boolean {
  const key = keyFor(windowId, ref);
  if (reviewing.has(key)) return false;
  reviewing.add(key);
  return true;
}

export function endReviewing(windowId: string, ref: Ref): void {
  reviewing.delete(keyFor(windowId, ref));
}

export function isReviewing(windowId: string, ref: Ref): boolean {
  return reviewing.has(keyFor(windowId, ref));
}

export function resetHeld(): void {
  starter = undefined;
  backend = undefined;
  starting.clear();
  reviewing.clear();
}
