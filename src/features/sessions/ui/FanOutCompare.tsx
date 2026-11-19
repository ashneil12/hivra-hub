// WP-135: one prompt, several chats. The person picks one. Nothing is merged.
import { useState } from "react";
import type { FanOutCompareRow } from "../model/fanOutView";

export type FanOutCompareModel = {
  rows: readonly FanOutCompareRow[];
  /** Models asked for that did not start, one plain line each. */
  notStarted?: readonly string[];
  onPick: (childId: string) => void | Promise<unknown>;
  onDiscard: (childId: string) => void | Promise<unknown>;
};

export function FanOutCompare({ view }: { view: FanOutCompareModel }) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = (childId: string, action: (childId: string) => void | Promise<unknown>) => {
    if (busy) return;
    setBusy(childId);
    void Promise.resolve(action(childId)).finally(() => setBusy(null));
  };

  return (
    <section data-fan-out-compare="" className="mb-2 rounded-md border border-current/15 p-2 text-left text-[12px]">
      <p className="mb-2 font-medium">Compare</p>
      <ul className="space-y-2">
        {view.rows.map((row) => (
          <li key={row.id} data-fan-out-child={row.id} className="rounded-md border border-current/10 p-2">
            <p>{row.label}</p>
            <p>{row.status}</p>
            <p>{row.excerpt}</p>
            <p>{row.worktree}</p>
            <p data-fan-out-spend="">{row.spend}</p>
            {row.winnerLine ? <p data-fan-out-winner="">{row.winnerLine}</p> : null}
            {row.cleanupLine ? <p data-fan-out-cleanup="">{row.cleanupLine}</p> : null}
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                disabled={busy !== null || row.winner || row.discarded}
                onClick={() => run(row.id, view.onPick)}
                className="rounded-md border border-current/20 px-2 py-1 disabled:opacity-40"
              >
                Pick this one
              </button>
              <button
                type="button"
                disabled={busy !== null || !row.canDiscard}
                onClick={() => run(row.id, view.onDiscard)}
                className="rounded-md border border-current/20 px-2 py-1 disabled:opacity-40"
              >
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
      {view.notStarted?.length ? (
        <ul data-fan-out-not-started="" className="mt-2 space-y-1">
          {view.notStarted.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
