// Cost for one chat, from the same turn figures the usage history (the status bar) adds up.
// A chat that never reported a cost is left out. Nothing here is guessed.

export type CostSession = {
  id: string;
  blocks?: readonly { turnMetrics?: { costUsd?: number } | null }[] | null;
};

export function costUsdBySession(sessions: readonly CostSession[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || !session.id) continue;
    let sum = 0;
    let any = false;
    for (const block of session.blocks ?? []) {
      const cost = block?.turnMetrics?.costUsd;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue;
      sum += cost;
      any = true;
    }
    if (any) out.set(session.id, sum);
  }
  return out;
}
