// Hivra WP-15: the crew reads every open delegation, not the newest page of recent rows.

import { tauriDelegations, type Delegation } from "../../monos/model/delegations";

/** Later `updatedAt` wins. A row with no id is ignored. Open rows are never dropped for a page cap. */
export function mergeDelegations(
  open: readonly Delegation[],
  recent: readonly Delegation[],
): Delegation[] {
  const byId = new Map<string, Delegation>();
  for (const row of [...open, ...recent]) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const previous = byId.get(row.id);
    if (!previous || (row.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * Open rows come from `list_open` (no page cap). `recent` only adds finished rows.
 * If the open list cannot be read, the load failed: a recent page is not a stand-in.
 */
export async function loadCrewDelegations(): Promise<
  { ok: true; value: Delegation[] } | { ok: false }
> {
  if (typeof tauriDelegations.listOpen !== "function") return { ok: false };
  let open: Delegation[];
  try {
    const listed = await tauriDelegations.listOpen();
    if (!Array.isArray(listed)) return { ok: false };
    open = listed;
  } catch {
    return { ok: false };
  }
  let recent: Delegation[] = [];
  if (typeof tauriDelegations.recent === "function") {
    try {
      const listed = await tauriDelegations.recent(0);
      if (Array.isArray(listed)) recent = listed;
    } catch {
      recent = [];
    }
  }
  return { ok: true, value: mergeDelegations(open, recent) };
}
