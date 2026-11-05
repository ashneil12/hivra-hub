/** A sort key strictly between two neighbours. Hivra stores order as text, not Orbit's integer position. */

const MIDDLE = "V";

function open(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length === 0 ? null : value;
}

function lowerThan(after: string): string | null {
  for (let index = 0; index < after.length; index += 1) {
    const code = after.charCodeAt(index);
    if (code > 1) return after.slice(0, index) + String.fromCharCode(code - 1);
  }
  return null;
}

function higherThan(before: string, after: string): string | null {
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1;
  if (index < before.length && index < after.length) {
    const gap = after.charCodeAt(index) - before.charCodeAt(index);
    if (gap > 1) {
      return before.slice(0, index) + String.fromCharCode(before.charCodeAt(index) + Math.floor(gap / 2));
    }
    const extended = `${before}${MIDDLE}`;
    if (extended < after) return extended;
    if (before.length >= 200) return null;
    return higherThan(`${before}0`, after);
  }
  if (index === before.length && index < after.length) {
    const extended = `${before}${MIDDLE}`;
    if (extended < after) return extended;
    const next = after.charCodeAt(index);
    if (next > 1) return before + String.fromCharCode(Math.floor(next / 2));
  }
  return null;
}

/** Null when the two keys are equal, reversed, or there is no room left under 200 characters. */
export function keyBetween(before: string | null, after: string | null): string | null {
  const lo = open(before);
  const hi = open(after);
  if (lo !== null && hi !== null && lo >= hi) return null;
  let key: string | null;
  if (lo === null && hi === null) key = MIDDLE;
  else if (hi === null) key = `${lo}${MIDDLE}`;
  else if (lo === null) key = lowerThan(hi);
  else key = higherThan(lo, hi);
  if (key == null || key.length === 0 || key.length > 200) return null;
  if (lo !== null && key <= lo) return null;
  if (hi !== null && key >= hi) return null;
  return key;
}
