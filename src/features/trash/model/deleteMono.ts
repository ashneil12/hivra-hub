// Moving a Mono to the trash. The confirm is the caller's, so the screen can keep its own wording.
// A running chat is stopped first, and the person has already been told. If another window still
// has the turn, nothing is moved.

export const STILL_RUNNING =
  "This chat is still running in another window. Stop it, then move the Mono to the trash.";

export type MonoTrashPlan = {
  confirmed: boolean;
  sessionId?: string;
  busy: boolean;
  /**
   * G2: its other one-to-one chats (further chats, its project chats). Each is stopped, trashed and removed with it the
   * same way as its main chat, so none stays behind as a plain chat.
   */
  otherChats?: readonly { id: string; busy: boolean }[];
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
  const chats = [
    ...(plan.sessionId ? [{ id: plan.sessionId, busy: plan.busy }] : []),
    ...(plan.otherChats ?? []).filter((chat) => chat.id !== plan.sessionId),
  ];
  for (const chat of chats) {
    if (!chat.busy) continue;
    await plan.stop(chat.id);
    plan.markStopped(chat.id);
    if (await plan.stillRunning(chat.id)) return false;
  }
  await plan.trash();
  for (const chat of chats) {
    const removed = await plan.removeChat(chat.id);
    if (!removed) return false;
  }
  plan.dropRoster();
  return true;
}
