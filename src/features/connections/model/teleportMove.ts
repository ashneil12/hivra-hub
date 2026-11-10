// The app's move path (WP-177): plan from the app's own session, approve with a person's click, move, and save through the
// same store the sidebar uses. Startup recovery finishes or undoes any move that stopped part way, from what was saved.

import type { Session } from "../../sessions/model/session";
import { approvePlan, moveChat, planMove, recoverMove, type MoveEndpoint, type MovePlan, type MoveResult } from "./teleport";
import { sessionToChat, type LocalChatPort } from "./teleportLocal";
import { savedFreezes } from "./teleportState";

/** The plan for a chat as the app holds it. `busy` comes from the app's live state, not from the saved row. */
export function planFromSession(session: Session, from: string, to: string) {
  return planMove(sessionToChat(session), from, to);
}

/** Approve with a person's click, then move. A gesture that is not a real trusted click moves nothing and throws. */
export async function approveAndMove(input: {
  session: Session;
  plan: MovePlan;
  gesture: unknown;
  from: MoveEndpoint;
  to: MoveEndpoint;
  moveId: string;
  at: string;
}): Promise<{ result: MoveResult }> {
  const approval = approvePlan(input.plan, input.gesture);
  const result = await moveChat({ chatId: input.session.id, from: input.from, to: input.to, approval, moveId: input.moveId, at: input.at });
  return { result };
}

/**
 * Startup recovery: every chat that still carries a saved freeze is finished or undone with the machine it was for.
 * Returns one line per freeze found.
 */
export async function recoverSavedMoves(input: {
  chatIds: string[];
  port: LocalChatPort;
  local: MoveEndpoint;
  remoteFor: (peer: string) => MoveEndpoint;
}): Promise<Array<{ chatId: string; moveId: string; status: MoveResult["status"] }>> {
  const lines: Array<{ chatId: string; moveId: string; status: MoveResult["status"] }> = [];
  for (const chatId of input.chatIds) {
    const session = await input.port.get(chatId);
    if (!session) continue;
    for (const freeze of savedFreezes(session)) {
      const result = await recoverMove({ chatId, moveId: freeze.moveId, from: input.local, to: input.remoteFor(freeze.peer) });
      lines.push({ chatId, moveId: freeze.moveId, status: result.status });
    }
  }
  return lines;
}

/** The paired hosts the app knows, as the start panel lists them. Empty when the machine list cannot be read. */
export async function listPairedHosts(): Promise<Array<{ id: string; name: string }>> {
  const { invoke } = await import("@tauri-apps/api/core");
  const machines = await invoke<Array<{ id: string; name: string }>>("remote_machines");
  return Array.isArray(machines) ? machines.map((m) => ({ id: m.id, name: m.name })) : [];
}
