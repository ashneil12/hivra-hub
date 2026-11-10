// WP-51: load reviewed memory for one turn. A timeout or a missing file recalls nothing this time.
// WP-99: each memory reaches a conversation once; a compaction or a restart sends them again.
// One decision covers every Mono the turn reads: at most three lines, in one fence, however many Monos there are.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc } from "../model/doc";
import { recallDecision } from "../model/recallPolicy";
import { recallFence } from "../model/recall";
import { noteShown, shownIds } from "../model/shownMemory";
import { recordRecall } from "../model/lastRecall";

/** The fence to append after the trusted note, or nothing. The system prompt is not involved. */
export async function recalledFence(
  mateId: string | undefined,
  message: string,
  wide?: { everyMate?: boolean; mateIds?: readonly string[]; sessionId?: string; compacted?: number; private?: boolean },
  /** WP-100: the engine reading this turn, so a fact another engine wrote says so. */
  readingEngine?: string,
): Promise<string | undefined> {
  if (!mateId) return undefined;
  // WP-111: a private chat is not given memory. Nothing comes in.
  if (wide?.private === true) return undefined;
  try {
    const loaded = await invoke<{ revision: number; doc: unknown }>("memory_review_load");
    const doc = parseDoc(loaded?.doc);
    const mates = wide?.everyMate
      ? [...new Set([mateId, ...(wide.mateIds ?? []).filter((id) => typeof id === "string" && id)])]
      : [mateId];
    // One conversation has one record of what it has shown, shared by every mate it reads.
    const sessionId = wide?.sessionId;
    const shown = sessionId ? shownIds(sessionId, wide?.compacted ?? 0) : undefined;
    const now = Date.now();
    const decision = recallDecision({ doc, mateId, mateIds: mates, message, now, mode: "automatic", exclude: shown });
    // WP-99: the Memory screen can say why each Mono's last turn got what it got.
    recordRecall(decision, now);
    const fence = recallFence(doc, decision.picked, readingEngine);
    if (!fence) return undefined;
    // A copy of a picked sentence under another Mono is as good as shown: noted too, it does not come back later.
    if (sessionId) noteShown(sessionId, [...decision.picked, ...decision.copiesShown]);
    return fence;
  } catch {
    return undefined;
  }
}
