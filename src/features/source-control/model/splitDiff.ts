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

function hasFullText(file: UnifiedDiffFileModel): boolean {
  return typeof file.beforeText === "string" && typeof file.afterText === "string";
}

/**
 * A textual file the review can only draw from its patch hunks, the way a pull
 * request is. Hunks are not the whole file, so a side-by-side view built from
 * them would start at line 1 and leave out everything between the hunks.
 * A file that shows a message instead of text, or is still loading, is not one.
 */
export function isPatchOnly(file: UnifiedDiffFileModel): boolean {
  if (file.binary || file.tooLarge || file.emptyMessage) return false;
  return !hasFullText(file) && file.blocks.length > 0;
}

/** Split is offered only when no file in the review would have to be drawn from a patch. */
export function canSplit(files: readonly UnifiedDiffFileModel[]): boolean {
  return !files.some(isPatchOnly);
}

/**
 * The file a review was asked to bring up: an explicit id, else the file whose
 * path or id matches. The same rule the unified view uses for focusId and focusPath.
 */
export function splitFocusId(
  files: readonly UnifiedDiffFileModel[],
  focusId: string | undefined,
  focusPath: string | undefined,
): string | undefined {
  if (focusId) return focusId;
  if (!focusPath) return undefined;
  return files.find((file) => file.path === focusPath || file.id === focusPath)?.id;
}

/** Text for the split view, or null when this file should show its message instead. */
export function splitFileText(file: UnifiedDiffFileModel): SplitFileText | null {
  if (file.binary || file.tooLarge || file.emptyMessage) return null;
  if (typeof file.beforeText !== "string" || typeof file.afterText !== "string") return null;
  const name = asText(file.label) || asText(file.path) || file.id;
  return { id: file.id, name, before: file.beforeText, after: file.afterText };
}
