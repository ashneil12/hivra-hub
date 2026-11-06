// WP-51: load reviewed memory for one turn. A timeout or a missing file recalls nothing this time.
// WP-99: each memory reaches a conversation once; a compaction or a restart sends them again.

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
  wide?: { everyMate?: boolean; mateIds?: readonly string[]; sessionId?: string; compacted?: number },
): Promise<string | undefined> {
  if (!mateId) return undefined;
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
    const blocks: string[] = [];
    const picked: string[] = [];
    for (const id of mates) {
      const decision = recallDecision({
        doc,
        mateId: id,
        message,
        now,
        mode: "automatic",
        exclude: shown,
      });
      // WP-99: the Memory screen can say why this Mono's last turn got what it got.
      recordRecall(decision, now);
      const block = recallFence(doc, decision.picked);
      if (!block) continue;
      blocks.push(block);
      picked.push(...decision.picked);
    }
    if (sessionId && picked.length) noteShown(sessionId, picked);
    return blocks.length ? blocks.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}
