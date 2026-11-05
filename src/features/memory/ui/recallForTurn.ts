// WP-51: load reviewed memory for one turn. A timeout or a missing file recalls nothing this time.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc } from "../model/doc";
import { recallIntoTurn } from "../model/recall";

/** The fence to append after the trusted note, or nothing. The system prompt is not involved. */
export async function recalledFence(
  mateId: string | undefined,
  message: string,
  wide?: { everyMate?: boolean; mateIds?: readonly string[] },
): Promise<string | undefined> {
  if (!mateId) return undefined;
  try {
    const loaded = await invoke<{ revision: number; doc: unknown }>("memory_review_load");
    const doc = parseDoc(loaded?.doc);
    const mates = wide?.everyMate
      ? [...new Set([mateId, ...(wide.mateIds ?? []).filter((id) => typeof id === "string" && id)])]
      : [mateId];
    const blocks = mates.flatMap((id) => {
      const next = recallIntoTurn({ system: "", message, doc, mateId: id });
      if (next.message === message) return [];
      const extra = next.message.slice(message.length).replace(/^\n\n/, "");
      return extra ? [extra] : [];
    });
    return blocks.length ? blocks.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}
