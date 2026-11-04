// Moving a Mono to the trash. The confirm is the caller's, so the screen can keep its own wording.
// A running chat is stopped first, and the person has already been told. If another window still
// has the turn, nothing is moved.

export const STILL_RUNNING =
  "This chat is still running in another window. Stop it, then move the Mono to the trash.";

export type MonoTrashPlan = {
  confirmed: boolean;
  sessionId?: string;
  busy: boolean;
  stop: (sessionId: string) => Promise<void>;
  markStopped: (sessionId: string) => void;
  stillRunning: (sessionId: string) => Promise<boolean>;
  trash: () => Promise<void>;
  removeChat: (sessionId: string) => Promise<boolean>;
  dropRoster: () => void;
};

/** True when the Mono was moved. False when the person said no, or the chat is still running. */
export async function deleteMonoToTrash(plan: MonoTrashPlan): Promise<boolean> {
  if (!plan.confirmed) return false;
  const sessionId = plan.sessionId;
  if (sessionId && plan.busy) {
    await plan.stop(sessionId);
    plan.markStopped(sessionId);
    if (await plan.stillRunning(sessionId)) return false;
  }
  await plan.trash();
  if (sessionId) {
    const removed = await plan.removeChat(sessionId);
    if (!removed) return false;
  }
  plan.dropRoster();
  return true;
}
