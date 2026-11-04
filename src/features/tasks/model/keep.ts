// WP-70: a load that fails, or one that finished after a newer one, does not replace what is on screen.

export type Loaded<T> = { ok: true; value: T } | { ok: false };

/** A timeout or an unreachable service keeps the list already shown. */
export function nextTasks<T>(previous: T[] | null, loaded: Loaded<T[]>): T[] | null {
  if (!loaded.ok) return previous;
  return loaded.value;
}

/**
 * A get that belongs to an older open (the person picked another task, or the project changed) is dropped.
 * A failed get keeps the task already shown.
 */
export function nextDetail<T>(previous: T | null, loaded: Loaded<T>, generation: number, current: number): T | null {
  if (generation !== current) return previous;
  if (!loaded.ok) return previous;
  return loaded.value;
}
