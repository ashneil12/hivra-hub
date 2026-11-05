// A bulk edit stops on the first stale write, skips a task that has gone, and stops when a newer
// bulk has started. It does not keep writing over a result that arrived late.

export type BulkStep = "ok" | "stale" | "missing";

export async function runBulk<T>(
  items: readonly T[],
  apply: (item: T) => Promise<BulkStep>,
  stillCurrent: () => boolean,
): Promise<"ok" | "stale" | "later" | "unreachable"> {
  if (items.length === 0) return "ok";
  for (const item of items) {
    if (!stillCurrent()) return "later";
    let step: BulkStep;
    try {
      step = await apply(item);
    } catch {
      return "unreachable";
    }
    if (!stillCurrent()) return "later";
    if (step === "stale") return "stale";
    if (step === "missing") continue;
  }
  return stillCurrent() ? "ok" : "later";
}
