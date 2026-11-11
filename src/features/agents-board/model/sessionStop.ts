// Stop from the Agents board. A delegation uses tasks.cancel. A project chat or a sub-chat
// uses the app's own Stop, and only when that Stop is registered. Anything else throws,
// so the panel can say the stop failed instead of looking done.

import { crewCancel, stopRequestId } from "../../crew/model/cancel";

type SessionStop = (sessionId: string) => Promise<unknown> | unknown;

let sessionStop: SessionStop | null = null;

/** The app registers the same Stop a chat's own button uses. A test clears it. */
export function setAgentsBoardSessionStop(fn: SessionStop | null): () => void {
  sessionStop = fn;
  return () => {
    if (sessionStop === fn) sessionStop = null;
  };
}

export function agentsBoardSessionStopReady(): boolean {
  return sessionStop != null;
}

const NO_PATH = "This chat can't be stopped from here";

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
    await crewCancel(owner, stopRequestId(row.id), {
      taskId: row.id,
      reason: "Stopped from the Agents board",
    });
    return;
  }
  const session = input.sessions.find((item) => item.id === id);
  if (!session || !sessionStop) throw new Error(NO_PATH);
  await sessionStop(session.id);
}
