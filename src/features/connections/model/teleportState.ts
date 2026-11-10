// The moved state of a chat on this Mac (WP-177), kept in the chat itself as a system notice, so it survives a
// restart without a schema change. While the chat is moved, this Mac keeps only the marker, not the transcript: the
// host holds the live copy.

import type { Block, Session } from "../../sessions/model/session";

const MOVED_PREFIX = "Moved to ";

export type TeleportState = { moved: false } | { moved: true; host: string; at: string };

export function movedBlocks(host: string, at: string): Block[] {
  return [
    {
      id: `teleported-${at}`,
      role: "system",
      text: `${MOVED_PREFIX}${host}`,
      notice: "teleported",
      startedAt: Date.parse(at),
    } as unknown as Block,
  ];
}

export function returnedBlocks(at: string): Block[] {
  return [
    {
      id: `teleported-back-${at}`,
      role: "system",
      text: "Moved back to this Mac",
      notice: "teleported-back",
      startedAt: Date.parse(at),
    } as unknown as Block,
  ];
}

/** The latest of the two notices decides. */
export function teleportStateOf(session: Pick<Session, "blocks">): TeleportState {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.notice === "teleported-back") return { moved: false };
    if (block.notice === "teleported") {
      const host = block.text.startsWith(MOVED_PREFIX) ? block.text.slice(MOVED_PREFIX.length) : block.text;
      return { moved: true, host, at: new Date(block.startedAt ?? 0).toISOString() };
    }
  }
  return { moved: false };
}

export function chatLocked(session: Pick<Session, "blocks">): boolean {
  return chatLockedFromBlocks(session.blocks);
}

/** The reason a send is refused, or null when the chat takes a turn. Nothing is sent for a moved chat. */
export function sendBlockReason(session: Pick<Session, "blocks">): string | null {
  const state = teleportStateOf(session);
  if (!state.moved) return null;
  return `This chat moved to ${state.host}. Nothing was sent. Move it back to continue here.`;
}

/** The marker line and the statement of what the target does with the chat. Plain words, no dashes. */
export function copyForMoved(host: string, time: string): string {
  return `Moved to ${host}, ${time}. It continues in a fresh session there, started from the saved messages.`;
}

/** The saved notice a move leaves while it freezes this chat. It lives in the chat, so a restart still sees it. */
export function frozenBlock(moveId: string): Block {
  return { id: `teleport-frozen-${moveId}`, role: "system", text: "", notice: "teleport-frozen" } as unknown as Block;
}

/** The saved notice that carries a moved copy until it is activated here. */
export function incomingBlock(moveId: string, chatJson: string): Block {
  return { id: `teleport-incoming-${moveId}`, role: "system", text: chatJson, notice: "teleport-incoming" } as unknown as Block;
}

export function hasBlock(blocks: Block[], id: string): boolean {
  return blocks.some((block) => block.id === id);
}

/** The move ids this chat is frozen for (a freeze is released by its own move, or by a recovery). */
export function frozenMoves(blocks: Block[]): string[] {
  return blocks.filter((b) => b.notice === "teleport-frozen").map((b) => b.id.replace(/^teleport-frozen-/, ""));
}

/** Locked for a send: moved away, or frozen by a move in progress. */
export function chatLockedFromBlocks(blocks: Block[]): boolean {
  return teleportStateOf({ blocks }).moved || frozenMoves(blocks).length > 0;
}
