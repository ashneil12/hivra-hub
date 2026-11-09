import type { UnifiedBlock } from "./unifiedDiff";
import type { UnifiedDiffFileModel } from "./unifiedDiffDocument";

/** One file the split view can show. The name is a label, not a path to open. */
export type SplitFileText = {
  id: string;
  name: string;
  before: string;
  after: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rebuilds the before and after text from hunk and fold lines when the review
 * only has a patch (a pull request). Full-file text, when the caller has it,
 * is kept as-is, including carriage returns.
 */
export function textsFromBlocks(blocks: readonly UnifiedBlock[]): {
  before: string;
  after: string;
} | null {
  if (blocks.length === 0) return null;
  const before: string[] = [];
  const after: string[] = [];
  let saw = false;
  for (const block of blocks) {
    if (!block || !Array.isArray(block.lines)) continue;
    for (const line of block.lines) {
      if (!line || (line.kind !== "add" && line.kind !== "del" && line.kind !== "context")) {
        continue;
      }
      saw = true;
      const text = asText(line.text);
      if (line.kind === "del" || line.kind === "context") before.push(text);
      if (line.kind === "add" || line.kind === "context") after.push(text);
    }
  }
  if (!saw) return null;
  return { before: before.join("\n"), after: after.join("\n") };
}

/** Text for the split view, or null when this file should show its message instead. */
export function splitFileText(file: UnifiedDiffFileModel): SplitFileText | null {
  if (file.binary || file.tooLarge || file.emptyMessage) return null;
  const name = asText(file.label) || asText(file.path) || file.id;
  if (typeof file.beforeText === "string" && typeof file.afterText === "string") {
    return { id: file.id, name, before: file.beforeText, after: file.afterText };
  }
  const rebuilt = textsFromBlocks(file.blocks);
  if (!rebuilt) return null;
  return { id: file.id, name, ...rebuilt };
}
