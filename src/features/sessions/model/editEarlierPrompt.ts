// WP-124: editing an earlier prompt rewrites the local transcript from that message. The provider is not rewound; only
// the last turn has a provider rewind, and only on the harnesses that already support it.

import { appNoteLine } from "./appNote";
import type { Block } from "./session";

export const EARLIER_PROMPT_NOTE =
  "Later replies belong to the earlier prompt. The replies after it were removed.";

export type EarlierPromptSeed = {
  id: number;
  blockId: string;
  text: string;
};

/** Index of a sent user prompt that can be edited, or -1. */
export function earlierPromptIndex(blocks: readonly Block[], blockId: string): number {
  return blocks.findIndex(
    (block) =>
      block.id === blockId &&
      block.role === "user" &&
      !block.draft &&
      !block.internal &&
      !appNoteLine(block) &&
      block.text.trim().length > 0,
  );
}

/** True when sending the edit would drop blocks that came after the prompt. */
export function earlierEditNeedsConfirm(blocks: readonly Block[], blockId: string): boolean {
  const index = earlierPromptIndex(blocks, blockId);
  return index >= 0 && index < blocks.length - 1;
}

/**
 * Blocks to keep when the prompt is resent: everything before it, plus a note when anything after it is dropped.
 * The prompt itself is not included; the send appends the new text. Null when the block cannot be edited.
 */
export function applyEarlierEdit(blocks: readonly Block[], blockId: string): Block[] | null {
  const index = earlierPromptIndex(blocks, blockId);
  if (index < 0) return null;
  const kept = blocks.slice(0, index);
  if (index === blocks.length - 1) return kept;
  let id = `earlier-prompt-${blockId}`;
  while (kept.some((block) => block.id === id)) id = `${id}-again`;
  return [
    ...kept,
    { id, role: "system", text: EARLIER_PROMPT_NOTE },
  ];
}

/** Busy, or a block that is no longer editable, is a refusal. The draft stays. */
export function earlierEditDecision(
  busy: boolean,
  blocks: readonly Block[],
  blockId: string,
): "ready" | "reject" {
  if (busy) return "reject";
  return applyEarlierEdit(blocks, blockId) ? "ready" : "reject";
}
