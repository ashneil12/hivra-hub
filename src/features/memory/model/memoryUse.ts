// WP-100: reading memory through a Mono's own tool is a use, so the facts it read are topped up. Disk stays the
// source of truth: the write is a compare-and-swap on the revision just read, and a failure is not final.

import type { MemoryDoc } from "./doc";
import { markUsed } from "./fade";
import { commitDoc } from "./review";

export type UsePorts = {
  load: () => Promise<MemoryDoc>;
  save: (revision: number, doc: MemoryDoc) => Promise<boolean>;
};

/**
 * Tops up each id it was given and marks the day lived. Returns whether the doc changed and was saved. A folder that
 * is busy or away saves nothing and does not throw: a missed use costs one fade step, not the turn.
 */
export async function recordUse(ports: UsePorts, ids: readonly string[], at: number): Promise<boolean> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!wanted.length) return false;
  try {
    const result = await commitDoc(ports.load, ports.save, (doc) => markUsed(doc, wanted, at));
    return result.applied;
  } catch {
    return false;
  }
}
