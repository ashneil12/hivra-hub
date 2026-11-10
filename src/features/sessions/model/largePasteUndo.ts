// WP-124: a large paste became a file. Undo puts that text back in the draft and drops the file. Only the latest
// paste is remembered. The 32 KiB threshold itself stays in largePaste.ts.

export type LargePasteUndo = {
  attachmentId: string;
  text: string;
};

/** The draft after undoing one large paste. A chip that is already gone still gets its text back. */
export function inlineAfterUndo<T extends { id: string }>(
  draft: string,
  attachments: readonly T[],
  undo: LargePasteUndo,
): { draft: string; attachments: T[] } {
  const kept = attachments.filter((file) => file.id !== undo.attachmentId);
  if (undo.text.length === 0) return { draft, attachments: kept };
  if (draft.length === 0) return { draft: undo.text, attachments: kept };
  const separator = draft.endsWith("\n") || draft.endsWith("\r") ? "" : "\n";
  return { draft: `${draft}${separator}${undo.text}`, attachments: kept };
}
