// The moved state of a chat on this Mac (WP-177), kept in the chat itself as a system notice, so it survives a
// restart without a schema change. While the chat is moved, this Mac keeps only the marker, not the transcript: the
// host holds the live copy.

import type { Block, Session } from "../../sessions/model/session";

const MOVED_PREFIX = "Moved to ";

export type TeleportState = { moved: false } | { moved: true; host: string; at: string };

export function movedBlocks(host: string, at: string, peer = ""): Block[] {
  return [
    {
      id: `teleported@${peer}@${at}`,
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

/** The machine id a chat was moved to, from the moved notice. Empty when the notice does not name one. */
export function movedPeer(session: Pick<Session, "blocks">): string {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    const block = session.blocks[i];
    if (block.notice === "teleported-back") return "";
    if (block.notice === "teleported") return block.id.split("@")[1] ?? "";
  }
  return "";
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
  return `Moved to ${host}, ${time}. It continues in a fresh session there, started from a brief of the saved messages.`;
}

/**
 * The saved notice a move leaves while it freezes this chat. It lives in the chat, so a restart still sees it. The text
 * names the machine the move is for, the window that froze the chat (its owner) and when (M1): recovery skips a young
 * freeze and never thaws another window's move.
 */
export function frozenBlock(moveId: string, peer: string, owner = "", at = new Date().toISOString()): Block {
  return { id: `teleport-frozen-${moveId}`, role: "system", text: JSON.stringify({ peer, owner, at }), notice: "teleport-frozen" } as unknown as Block;
}

function parseText(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The freezes saved in a chat, each with the machine it is for, its owner window and its start. A restart uses them. */
export function savedFreezes(session: Pick<Session, "blocks">): Array<{ moveId: string; peer: string; owner: string; at: number }> {
  return session.blocks
    .filter((b) => b.notice === "teleport-frozen")
    .map((b) => {
      const meta = parseText(b.text);
      return {
        moveId: b.id.replace(/^teleport-frozen-/, ""),
        peer: asText(meta.peer),
        owner: asText(meta.owner),
        at: Date.parse(asText(meta.at)) || 0,
      };
    });
}

/** The saved notice that carries a moved copy until it is activated here. The text names the machine that sent it. */
export function incomingBlock(moveId: string, peer: string, chatJson: string, at = Date.now()): Block {
  return { id: `teleport-incoming-${moveId}`, role: "system", text: JSON.stringify({ peer, chat: chatJson, at }), notice: "teleport-incoming" } as unknown as Block;
}

/** The copies stored here, each with the machine that sent it, its chat JSON and when it arrived. */
export function savedIncoming(session: Pick<Session, "blocks">): Array<{ moveId: string; peer: string; chat: string; at: number }> {
  return session.blocks
    .filter((b) => b.notice === "teleport-incoming")
    .map((b) => {
      const meta = parseText(b.text);
      return { moveId: b.id.replace(/^teleport-incoming-/, ""), peer: asText(meta.peer), chat: asText(meta.chat), at: typeof meta.at === "number" ? meta.at : 0 };
    });
}

/** The notice a move leaves here when this machine refuses that move id for good: a late copy of it is refused. */
export function abortedBlock(moveId: string, peer = ""): Block {
  return { id: `teleport-aborted-${moveId}`, role: "system", text: JSON.stringify({ peer }), notice: "teleport-aborted" } as unknown as Block;
}

/** The refused moves saved here, each with the machine the move was from or to: recovery tells that machine to thaw. */
export function savedAborted(session: Pick<Session, "blocks">): Array<{ moveId: string; peer: string }> {
  return session.blocks
    .filter((b) => b.notice === "teleport-aborted")
    .map((b) => ({ moveId: b.id.replace(/^teleport-aborted-/, ""), peer: asText(parseText(b.text).peer) }));
}

/** The move ids this machine has refused for good. */
export function abortedMoves(blocks: Block[]): string[] {
  return blocks.filter((b) => b.notice === "teleport-aborted").map((b) => b.id.replace(/^teleport-aborted-/, ""));
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
