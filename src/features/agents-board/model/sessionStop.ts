// Stop from the Agents board. A delegation uses tasks.cancel. A project chat or a sub-chat
// uses the app's own Stop, and only when that Stop is registered. Anything else throws,
// so the panel can say the stop failed instead of looking done.

import { crewCancel, stopRequestId } from "../../crew/model/cancel";

type SessionStop = (sessionId: string) => Promise<unknown> | unknown;

let sessionStop: SessionStop | null = null;
let readyVersion = 0;
const readyListeners = new Set<() => void>();

function noteReady(): void {
  readyVersion += 1;
  for (const listener of readyListeners) listener();
}

/** The app registers the same Stop a chat's own button uses. A test clears it. */
export function setAgentsBoardSessionStop(fn: SessionStop | null): () => void {
  sessionStop = fn;
  noteReady();
  return () => {
    if (sessionStop === fn) {
      sessionStop = null;
      noteReady();
    }
  };
}

/** The board reads whether Stop is registered while it builds, so it has to hear this change. */
export function subscribeAgentsBoardSessionStop(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

export function agentsBoardSessionStopVersion(): number {
  return readyVersion;
}

export function agentsBoardSessionStopReady(): boolean {
  return sessionStop != null;
}

const NO_PATH = "This chat can't be stopped from here";
const STILL_RUNNING = "it is still running. Open the chat and stop it there";

/**
 * tasks.cancel and the chat's tree Stop resolve with the chats whose Stop failed or timed out (`stopFailed`) and the
 * ones whose workers couldn't be loaded (`unloaded`, stopTree.ts). Either means something may still run.
 */
function stopLeftRunning(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const { stopFailed, unloaded } = result as { stopFailed?: unknown; unloaded?: unknown };
  return (Array.isArray(stopFailed) && stopFailed.length > 0) || (Array.isArray(unloaded) && unloaded.length > 0);
}

export async function stopBoardRow(
  id: string,
  input: {
    delegations: readonly { id: string; ownerSession?: string | null }[];
    sessions: readonly { id: string }[];
  },
): Promise<void> {
  const row = input.delegations.find((item) => item.id === id);
  if (row) {
    const owner = row.ownerSession?.trim();
    if (!owner) throw new Error(NO_PATH);
    const result = await crewCancel(owner, stopRequestId(row.id), {
      taskId: row.id,
      reason: "Stopped from the Agents board",
    });
    if (stopLeftRunning(result)) throw new Error(STILL_RUNNING);
    return;
  }
  const session = input.sessions.find((item) => item.id === id);
  if (!session || !sessionStop) throw new Error(NO_PATH);
  if (stopLeftRunning(await sessionStop(session.id))) throw new Error(STILL_RUNNING);
}
