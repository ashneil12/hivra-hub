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
  "transcript-secret-held": "Move held: the transcript has a value that looks like a key",
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
