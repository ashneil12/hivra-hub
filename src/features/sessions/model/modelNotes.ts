/**
 * Short caveats seeded by a Hivra release. The picker reads this map; it is
 * not edited in the app. Keys are catalog ids, native ids, or alias targets.
 */

const FABLE_52_NOTE = "Effort levels may behave differently from Fable 5.1.";

export const MODEL_NOTES: Readonly<Record<string, string>> = {
  "claude:fable-5-2": FABLE_52_NOTE,
  "claude-fable-5-2": FABLE_52_NOTE,
};

export function visibleModelNote(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function modelNote(model: {
  id: string;
  nativeId?: string;
  aliasTarget?: string;
}): string | undefined {
  for (const key of [model.id, model.nativeId, model.aliasTarget]) {
    if (!key) continue;
    const note = visibleModelNote(MODEL_NOTES[key]);
    if (note) return note;
  }
  return undefined;
}
