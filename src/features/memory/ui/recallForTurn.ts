// WP-51: load reviewed memory for one turn. A timeout or a missing file recalls nothing this time.

import { invoke } from "@tauri-apps/api/core";
import { parseDoc } from "../model/doc";
import { recallIntoTurn } from "../model/recall";

/** The fence to append after the trusted note, or nothing. The system prompt is not involved. */
export async function recalledFence(mateId: string | undefined, message: string): Promise<string | undefined> {
  if (!mateId) return undefined;
  try {
    const loaded = await invoke<{ revision: number; doc: unknown }>("memory_review_load");
    const doc = parseDoc(loaded?.doc);
    const next = recallIntoTurn({ system: "", message, doc, mateId });
    if (next.message === message) return undefined;
    const extra = next.message.slice(message.length).replace(/^\n\n/, "");
    return extra || undefined;
  } catch {
    return undefined;
  }
}
