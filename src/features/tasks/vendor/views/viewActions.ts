// Orbit's viewActions.ts opens a confirm dialog (sonner, confirmAction) and copies a workspace URL.
// Hivra has neither, so this keeps the path and the delete rules and leaves the dialog to the screen.
// Rewritten because those two imports do not exist here.

/** A saved view's path. The id is encoded so a unicode name cannot break the URL. */
export function viewPath(viewId: string): string {
  return `/views/${encodeURIComponent(viewId)}`;
}

/** The default view is builtin and cannot be deleted or renamed. */
export function canDeleteView(view: { builtin?: boolean }): boolean {
  return view.builtin !== true;
}

/** Sentence shown before a view is deleted. An empty name still gets a sentence. */
export function deleteViewPrompt(view: { name: string }): string {
  const name = view.name.trim() || "This view";
  return `${name} will be deleted.`;
}
