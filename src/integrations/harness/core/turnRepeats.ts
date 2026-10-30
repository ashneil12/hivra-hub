import type { Block } from "../../../features/sessions/model/session";

// r87 step 3, Ash 30 Oct 06:59: "drop a word-for-word repeat within one turn". c02 r86 run 2: the Lead said each update,
// read the code to check it, then said the same update again word for word (six times in one run). The prompt already
// says never repeat a line; this is the hub's side of it.

const normal = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The turn's finished replies without one that says, word for word, what an earlier reply in the same turn said. A
 * turn starts at the last user message; a reply still streaming is left alone (it may yet differ).
 */
export function withoutTurnRepeats(blocks: Block[]): Block[] {
  let start = blocks.length;
  while (start > 0 && blocks[start - 1].role !== "user") start -= 1;
  const said = new Set<string>();
  let dropped = false;
  const kept = blocks.filter((block, index) => {
    if (index < start || block.role !== "assistant" || block.streaming) return true;
    const text = normal(block.text);
    if (!text) return true;
    if (said.has(text)) {
      dropped = true;
      return false;
    }
    said.add(text);
    return true;
  });
  return dropped ? kept : blocks;
}
