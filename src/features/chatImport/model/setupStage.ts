// Where the "bring my chats over" setup stands. It comes in parts: first run starts the sweep and lets the person
// into the app; when the chats are found the app calls them back to choose what comes in; when the chats have been
// read it calls them back again for the suggested rules. The stage is kept beside the other first-run flags, so a
// relaunch picks the setup up where it was (the sweep is simply run again; nothing was written by it).

export type SetupStage =
  /** Not started, or finished. */
  | "off"
  /** Looking for chats. */
  | "sweep"
  /** Found: waiting for the person to choose what comes in. */
  | "choose"
  /** Chats are coming in. */
  | "importing"
  /** Chats are in; a model is reading a spread of them. */
  | "reading"
  /** Suggested rules are waiting for the person. */
  | "rules";

export type SetupState = { stage: SetupStage; learn: boolean };

const KEY = "monocode:chat-import-setup";
const STAGES: SetupStage[] = ["off", "sweep", "choose", "importing", "reading", "rules"];
const OFF: SetupState = { stage: "off", learn: false };

let current: SetupState | undefined;
const listeners = new Set<() => void>();

function load(): SetupState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<SetupState> | null;
    if (raw && STAGES.includes(raw.stage as SetupStage)) return { stage: raw.stage as SetupStage, learn: raw.learn === true };
  } catch {
    // Unreadable is off.
  }
  return OFF;
}

export function setupState(): SetupState {
  current ??= load();
  return current;
}

export function setSetupState(next: SetupState): void {
  const now = setupState();
  if (now.stage === next.stage && now.learn === next.learn) return;
  current = next;
  try {
    if (next.stage === "off") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept in memory for this run.
  }
  for (const listener of listeners) listener();
}

export function subscribeSetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetSetupForTest(): void {
  current = undefined;
  listeners.clear();
}
