/** Which way a review shows a diff. Unified is the default; split is optional. */

export const DIFF_PRESENTATION_KEY = "monocode.diffLayout";

export const DIFF_PRESENTATIONS = ["unified", "split"] as const;

export type DiffPresentation = (typeof DIFF_PRESENTATIONS)[number];

type PresentationStore = Pick<Storage, "getItem" | "setItem">;

/** Disk and other windows are untrusted. Anything other than the two names is unified. */
export function parseDiffPresentation(value: unknown): DiffPresentation {
  return value === "split" ? "split" : "unified";
}

export function readDiffPresentation(
  storage: PresentationStore = localStorage,
): DiffPresentation {
  try {
    return parseDiffPresentation(storage.getItem(DIFF_PRESENTATION_KEY));
  } catch {
    return "unified";
  }
}

/**
 * Remembers the choice. A store that throws (private mode, a full disk) is not
 * a final failure: this window still keeps the choice in memory.
 * Writing the value that is already stored does nothing, so two windows do not
 * bounce the same choice back and forth.
 */
export function writeDiffPresentation(
  value: DiffPresentation,
  storage: PresentationStore = localStorage,
): void {
  const next = parseDiffPresentation(value);
  try {
    if (storage.getItem(DIFF_PRESENTATION_KEY) === next) return;
    storage.setItem(DIFF_PRESENTATION_KEY, next);
  } catch {
    // The caller keeps `next` in React state.
  }
}
