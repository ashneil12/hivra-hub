// WP-124: a line in the transcript when the model changes and the CLI stays the same. A CLI change is a handoff
// (WP-117) and is not marked here.

import { appNoteLine } from "./appNote";
import { findModel } from "./models";
import type { Block } from "./session";

export type SwitchSession = {
  harness: string;
  model: string;
  blocks: Block[];
};

function hasSentPrompt(blocks: readonly Block[]): boolean {
  return blocks.some(
    (block) =>
      block.role === "user" &&
      !block.draft &&
      !block.internal &&
      !appNoteLine(block) &&
      block.text.trim().length > 0,
  );
}

function markerId(blocks: readonly Block[], toId: string): string {
  const taken = new Set(blocks.map((block) => block.id));
  let id = `model-switch-${blocks.length}-${toId}`;
  while (taken.has(id)) id = `${id}-again`;
  return id;
}

/** Append a system line when the model changed on the same CLI after a real prompt. Otherwise return `after`. */
export function withModelSwitchMarker<T extends SwitchSession>(
  before: T,
  after: T,
  labelOf: (id: string) => string = (id) => findModel(id)?.name ?? id,
): T {
  if (before.harness !== after.harness) return after;
  if (before.model === after.model) return after;
  if (!hasSentPrompt(before.blocks)) return after;
  const text = `Switched model from ${labelOf(before.model)} to ${labelOf(after.model)}.`;
  const last = after.blocks[after.blocks.length - 1];
  if (last?.role === "system" && last.text === text) return after;
  const block: Block = { id: markerId(after.blocks, after.model), role: "system", text };
  return { ...after, blocks: [...after.blocks, block] };
}
