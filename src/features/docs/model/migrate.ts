// First open of a note that has no blocks yet: Markdown becomes blocks.
// A failed conversion leaves the blocks empty and the Markdown where it was.

import { markdownToBlocks } from "./markdown";
import type { Block, MentionTarget } from "./types";

export type MigratedNote = {
  body: string;
  blocks: Block[] | null;
  /** True when conversion failed. The body is unchanged. */
  failed: boolean;
};

export function migrateNote(
  note: { body: string; blocksJson: string | null },
  members: readonly MentionTarget[] = [],
  convert: (markdown: string, members: readonly MentionTarget[]) => Block[] = markdownToBlocks,
): MigratedNote {
  const body = note.body;
  if (note.blocksJson != null && note.blocksJson !== "") {
    try {
      const parsed = JSON.parse(note.blocksJson) as unknown;
      if (!Array.isArray(parsed)) return { body, blocks: null, failed: true };
      return { body, blocks: parsed as Block[], failed: false };
    } catch {
      return { body, blocks: null, failed: true };
    }
  }
  try {
    return { body, blocks: convert(body, members), failed: false };
  } catch {
    return { body, blocks: null, failed: true };
  }
}
