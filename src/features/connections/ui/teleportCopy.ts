// Words for the chat move (WP-177): the marker on a chat that is now on a host, and the refusal copy. Plain words,
// no dashes, and never a silent switch: a chat that cannot move says why, and the recap is offered as the fallback.

import type { MoveRefusal, MoveRefusalReason } from "../model/teleport";

export function teleportMarker(host: string, time: string): string {
  return `Moved to ${host}, ${time}`;
}

export interface TeleportRefusalCopy {
  title: string;
  body: string;
  recap: boolean;
  recapLabel?: string;
}

const TITLES: Record<MoveRefusalReason, string> = {
  "turn-running": "Finish this turn, then move",
  "approval-pending": "Answer the approval, then move",
  "approval-missing": "Approve the move first",
  "approval-stale": "The chat changed. Review the move again",
  "private-key-held": "This chat holds a private key, so the move is held. Nothing was sent",
  "invalid-session-id": "This chat cannot move: its session id is not in a form a move accepts",
  "id-mismatch": "This chat's record names another chat. Nothing was moved",
  "not-found": "This chat is not here to move",
  "not-owner": "This chat is on another machine",
  "cannot-resume": "Start a new chat with a recap, because the other machine cannot resume this chat",
  "held-elsewhere": "Already moving",
  "state-changed": "The chat changed while it moved. Review the move again",
};

const RECAP_LABEL = "Start a new chat with a recap";

export function teleportRefusalCopy(refusal: Pick<MoveRefusal, "reason" | "message" | "recapOffered">): TeleportRefusalCopy {
  const recap = refusal.reason === "cannot-resume" && refusal.recapOffered === true;
  return {
    title: TITLES[refusal.reason],
    body: refusal.message,
    recap,
    ...(recap ? { recapLabel: RECAP_LABEL } : {}),
  };
}

/** What the person reads after a move attempt. A partial or unknown move is never described as "stayed where it was". */
export function moveResultMessage(result: { status: string; message?: string }, direction: "out" | "back" = "out"): string {
  switch (result.status) {
    case "moved":
      return "Moved. The chat now runs on the other machine.";
    case "partial":
      return direction === "back"
        ? "This Mac has the chat, and the host has not released its copy yet. Retry to finish the move."
        : "The host has the chat, and this Mac has not released its copy yet. Retry to finish the move.";
    case "unknown":
      return "The result is unknown: the host may already have the chat. The chat stays locked here until it is checked. Retry to check.";
    case "failed":
    case "recovered":
      return `The move did not finish, and the chat stayed where it was. ${result.message ?? ""}`.trim();
    case "refused":
      return result.message ?? "The move was refused. Nothing was sent.";
    default:
      return "The move did not finish.";
  }
}
