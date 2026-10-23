// What the workspace allows at once. The number is the same for every project today.
export const LIMIT = 10;

export function canStart(running) {
  return running < LIMIT;
}
