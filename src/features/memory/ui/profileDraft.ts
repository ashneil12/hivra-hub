// WP-83: a profile box keeps what the person typed while a load or a save is in flight.

/** A late load fills an untouched box. A box the person already edited stays as they left it. */
export function textAfterLoad(typed: string, dirty: boolean, loaded: string): string {
  return dirty ? typed : loaded;
}

/**
 * A save that lands replaces the box only when it still holds what was saved.
 * Typing during the save keeps the newer text and leaves the box dirty.
 */
export function textAfterSave(
  typedNow: string,
  saved: string,
  loaded: string,
): { text: string; dirty: boolean } {
  if (typedNow === saved) return { text: loaded, dirty: false };
  return { text: typedNow, dirty: true };
}
