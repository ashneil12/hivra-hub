// Words a turn carries for a filter over its chat (the one chat's project filter: asks/model/chiefLens.ts). Whoever
// knows how lends one tagger; the transcript puts what it returns on the turn as `data-turn-tags`, and the filter hides
// the turns that don't carry its word. A chat with no tagger lent, or a tagger that says nothing, carries no tags.
import type { Block } from "./session";

type Tagger = (sessionId: string, turn: readonly Block[]) => string | undefined;
let tagger: Tagger | undefined;

export function setTurnTagger(next: Tagger | undefined): () => void {
  tagger = next;
  return () => {
    if (tagger === next) tagger = undefined;
  };
}

export function turnTags(sessionId: string | undefined, turn: readonly Block[]): string | undefined {
  if (!sessionId || !tagger) return undefined;
  try {
    return tagger(sessionId, turn) || undefined;
  } catch {
    return undefined;
  }
}
