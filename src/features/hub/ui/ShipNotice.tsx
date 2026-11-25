import { useState } from "react";
import { markShipSeen, restartForUpdate, shipCardView, useShipStatus } from "../../../app/model/ship";
import { revealPath } from "../../../platform/tauri/fs";

/**
 * Ship on the main pane (src-tauri/src/ship.rs): a slim bar only when Ash must act, an update waiting for a quiet
 * moment (with Restart now) or a trial that failed or was rolled back (with its log, until read). A build that merely
 * arrived, a trial in progress and a receipt draw nothing: he does not use them, because breakage shows on the dev
 * copy first (Ash, 13 Nov: "that whole area right there isn't really that useful, and it's also just a waste of
 * space"). The receipt and its log are reachable in Settings, General, beside the version (ShipLogButton). Plain
 * words, no badge. A button the app couldn't carry out says so.
 */
export function ShipNotice() {
  const view = shipCardView(useShipStatus());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  if (!view) return null;
  const act = (what: string, run: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    void run()
      .catch((error: unknown) =>
        setProblem({ id: view.id, text: `Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}` }),
      )
      .finally(() => setBusy(false));
  };
  return (
    // A slim bar across the top of the main pane.
    <div className="shrink-0 border-b border-stroke px-3 py-1.5" data-hub-ship={view.id}>
      <section aria-label="Update" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[13px] leading-5 text-content">{view.text}</p>
        {view.detail ? <p className="text-[12px] leading-5 text-content/60">{view.detail}</p> : null}
        {view.restartNow || view.log || view.dismiss ? (
          <div className="flex flex-wrap gap-2 text-[12px]">
            {view.restartNow ? (
              <button type="button" disabled={busy} onClick={() => act("restart for the update", restartForUpdate)} className="rounded-md bg-content/8 px-2.5 py-1 text-content hover:bg-content/12 disabled:opacity-50">
                Restart now
              </button>
            ) : null}
            {view.log ? (
              <button type="button" onClick={() => act("show the log", () => revealPath(view.log!))} className="rounded-md px-2.5 py-1 text-content/70 hover:bg-content/5 hover:text-content">
                Show the log
              </button>
            ) : null}
            {view.dismiss ? (
              <button type="button" disabled={busy} onClick={() => act("mark it read", () => markShipSeen(view.id))} className="rounded-md px-2.5 py-1 text-content/70 hover:bg-content/5 hover:text-content">
                Done
              </button>
            ) : null}
          </div>
        ) : null}
        {problem?.id === view.id ? (
          <p role="alert" className="mt-1.5 text-[12px] leading-5 text-content/70">
            {problem.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}
