// WP-51: load reviewed memory for one turn. A timeout or a missing file recalls nothing this time.
// WP-99: each memory reaches a conversation once; a compaction or a restart sends them again.
// One decision covers every Mono the turn reads: at most three lines, in one fence, however many Monos there are.
// WP-241: two tiers. The turn's first mate's essential set rides in the chat once (and a short "what changed" block
// when it moves); the per-turn recall leaves those facts out. When the cheap tier is on, its model may rank the turn's
// candidates within a second; otherwise, or when it is late, the lexical pick stands.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc } from "../model/doc";
import { cheapAsk, cheapProblem } from "../model/cheapAsk";
import { essentialTurnBlock } from "../model/essential";
import { takeBudget } from "../model/memoryBudget";
import { rankCandidates, rankRecall } from "../model/rank";
import { RECALL_MAX_LINES, recallDecision } from "../model/recallPolicy";
import { recallFence } from "../model/recall";
import { noteShown, shownIds } from "../model/shownMemory";
import { recordRecall } from "../model/lastRecall";
import { loadMemoryTier } from "../model/tier";
import type { CuratorAsk } from "../model/curator";

/** WP-241: the cheap tier's model, when it is on and can be asked; tests pass their own. */
export type RankAsk = ((prompt: string) => Promise<CuratorAsk>) | undefined;

function rankAskNow(now: number): RankAsk {
  const choice = loadMemoryTier();
  if (choice.tier !== "cheap" || !choice.model || cheapProblem(choice.model)) return undefined;
  // A rank is a model call, so it spends the memory budget like the curator; none left means the lexical pick.
  if (!takeBudget(now).ok) return undefined;
  return cheapAsk(choice.model);
}

/** The fence to append after the trusted note, or nothing. The system prompt is not involved. */
export async function recalledFence(
  mateId: string | undefined,
  message: string,
  wide?: { everyMate?: boolean; mateIds?: readonly string[]; sessionId?: string; compacted?: number; private?: boolean },
  /** WP-100: the engine reading this turn, so a fact another engine wrote says so. */
  readingEngine?: string,
  /** WP-241: the model rank, for tests. Absent: the cheap tier's model when it is on. */
  rankAsk?: RankAsk | null,
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
    // WP-241: the essential set is already in this chat, so the turn's recall does not repeat it.
    const essential = sessionId ? essentialTurnBlock(doc, mateId, sessionId, wide?.compacted ?? 0) : { ids: [] as string[] };
    const exclude = new Set([...(shown ?? []), ...essential.ids]);
    const now = Date.now();
    const decision = recallDecision({ doc, mateId, mateIds: mates, message, now, mode: "automatic", exclude });
    let picked = decision.picked;
    const candidates = rankCandidates(doc, decision, exclude);
    const ask = candidates.length ? (rankAsk === undefined ? rankAskNow(now) : (rankAsk ?? undefined)) : undefined;
    if (ask) {
      const ranked = await rankRecall(message, candidates, ask, RECALL_MAX_LINES);
      if (ranked) picked = ranked;
    }
    // WP-99: the Memory screen can say why each Mono's last turn got what it got.
    recordRecall(picked === decision.picked ? decision : { ...decision, picked }, now);
    const fence = recallFence(doc, picked, readingEngine);
    // A copy of a picked sentence under another Mono is as good as shown: noted too, it does not come back later.
    if (sessionId && fence) noteShown(sessionId, [...picked, ...decision.copiesShown]);
    const parts = [essential.block, fence].filter((part): part is string => !!part);
    return parts.length ? parts.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}
