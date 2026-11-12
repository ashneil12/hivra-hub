// Where a learn run stands, for any screen that wants to show it. The run writes here; a screen
// (Settings, or a later onboarding step) reads it. No Tauri in this file.

import { useSyncExternalStore } from "react";
import type { ShownProposal } from "./LearnFromChats";

export type LearnRunPhase = "idle" | "listing" | "reading" | "asking" | "done" | "failed";

export type LearnRunStatus = {
  phase: LearnRunPhase;
  /** Chats read so far, and how many the run is aiming for. */
  read: number;
  target: number;
  /** Chats the model was shown, once it has been asked. */
  chats: number;
  /** The suggestions of the last finished run that nobody has decided yet. */
  proposals: ShownProposal[];
  /** Older chats left out of the list, and chats too big to read. */
  leftOut: number;
  tooBig: number;
  /** A plain sentence when the run failed or found nothing. */
  note: string;
};

const IDLE: LearnRunStatus = {
  phase: "idle",
  read: 0,
  target: 0,
  chats: 0,
  proposals: [],
  leftOut: 0,
  tooBig: 0,
  note: "",
};

let current: LearnRunStatus = IDLE;
const listeners = new Set<() => void>();

export function learnRunStatus(): LearnRunStatus {
  return current;
}

export function setLearnRunStatus(patch: Partial<LearnRunStatus>): void {
  current = { ...current, ...patch };
  for (const listener of [...listeners]) listener();
}

export function resetLearnRunStatus(): void {
  current = IDLE;
  for (const listener of [...listeners]) listener();
}

export function subscribeLearnRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For a screen: re-renders as the run moves. */
export function useLearnRun(): LearnRunStatus {
  return useSyncExternalStore(subscribeLearnRun, learnRunStatus, learnRunStatus);
}

export function learnRunBusy(status: LearnRunStatus = current): boolean {
  return status.phase === "listing" || status.phase === "reading" || status.phase === "asking";
}
