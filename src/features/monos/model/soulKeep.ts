// WP-21: a person's edit of a soul is not a known template (Mercury). A missing file is not an edit.

import { needsMigration } from "./vendor/mercurySoul";

/** True when the file is on disk and is not an exact known template. A missing file is not an edit. */
export function keepsEditedSoul(text: string | null | undefined, knownTemplates: readonly string[]): boolean {
  if (text == null) return false;
  return !needsMigration(text, knownTemplates);
}
