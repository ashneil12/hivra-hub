// Where Open goes. A row with a chat opens that chat. A needs-you row with no chat of its
// own opens the owner's chat, then the project's workspace, which is where that item is answered.

import { openFromHome } from "../../home/model/opener";
import type { BoardRole } from "./tree";

export type BoardOpenNode = {
  id: string;
  role: BoardRole;
  sessionId: string | null;
  projectId: string | null;
};

export type BoardOpenTarget =
  | { kind: "chat"; sessionId: string; projectId: string }
  | { kind: "needs-you"; id: string; projectId: string };

export function boardOpenTarget(node: BoardOpenNode, ownerSession?: string | null): BoardOpenTarget | null {
  const session = node.sessionId?.trim() || ownerSession?.trim() || "";
  const projectId = node.projectId?.trim() || "";
  if (session) return { kind: "chat", sessionId: session, projectId };
  if (node.role === "home" || node.role === "project" || node.role === "subchat" || node.role === "mate") {
    const id = node.id.trim();
    if (!id) return null;
    return { kind: "chat", sessionId: id, projectId };
  }
  const id = node.id.trim();
  if (!projectId || !id) return null;
  return { kind: "needs-you", id, projectId };
}

/** Leave the board for the chat, or for the project when the needs-you row has no chat yet. */
export function openBoardRow(node: BoardOpenNode, ownerSession?: string | null): void {
  const target = boardOpenTarget(node, ownerSession);
  if (!target) return;
  if (target.kind === "chat") {
    openFromHome({ kind: "chat", id: target.sessionId, projectId: target.projectId });
    return;
  }
  openFromHome({ kind: "coding", projectId: target.projectId });
}
