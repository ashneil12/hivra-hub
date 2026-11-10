/**
 * Whether an id is safe to save as a store key. The Rust side (`validate_id`) refuses
 * anything else, and a path or a space would fail the whole upsert.
 */
export function isPersistableId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
