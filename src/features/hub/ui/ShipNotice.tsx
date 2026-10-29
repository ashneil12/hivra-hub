import { useEffect, useState } from "react";
import { acceptShip, markShipSeen, restartForUpdate, shipCardView, useShipStatus } from "../../../app/model/ship";
import { revealPath } from "../../../platform/tauri/fs";
import { readAppVersion } from "../../../app/model/updater";

let knownVersion: string | undefined;
/** The running app's version, read once: a committed ship is the build that is running. */
function useAppVersion(): string | undefined {
  const [version, setVersion] = useState(knownVersion);
  useEffect(() => {
    if (knownVersion) return;
    let live = true;
    void readAppVersion().then((v) => {
      knownVersion = v;
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return version;
}

/**
 * Ship on Today (src-tauri/src/ship.rs): the new build's trial, an update waiting for a quiet moment (with Restart now),
 * the last ship's receipt until it's read, or the question Ash answers himself once it has committed (does the build
 * work?). Plain words, no badge. A button the app couldn't carry out says so.
 */
export function ShipNotice({ inBody = false, appAsk = true }: { inBody?: boolean; appAsk?: boolean } = {}) {
  const appVersion = useAppVersion();
  const card = shipCardView(useShipStatus(), appVersion);
  // r63 (PM's G2 on 0.16.3): "Is everything working?" is about the app, not a project, so a project's Today asks it only
  // where appAsk says (the first project in the rail), never in a project Ash has just made.
  const live = card?.accept && !appAsk ? null : card;
  // A card shown once (a committed update) is marked read the moment it is on screen and stays put until Today goes
  // away, so it never comes back and never needs a Done (Critiquito/Ash, 22 Oct: "show once").
  const [held, setHeld] = useState<typeof live>(null);
  const view = live ?? (held && held.once ? held : null);
  const onceId = live?.once ? live.id : undefined;
  useEffect(() => {
    if (!onceId || !live) return;
    setHeld(live);
    void markShipSeen(onceId).catch(() => undefined);
    // Once per receipt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onceId]);
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
    // In Today's body (r28) it sits below the Since paragraph, in the body's own column; on its own it keeps its margins.
    <div className={inBody ? "" : "mx-auto max-w-[720px] px-8 pt-8"} data-hub-ship={view.id}>
      <section aria-label="Update" className="rounded-lg border border-stroke px-3 py-2.5 hub-fade-in">
        <p className="text-[13px] leading-5 text-content">{view.text}</p>
        {view.detail ? <p className="mt-0.5 text-[12px] leading-5 text-content/60">{view.detail}</p> : null}
        {view.restartNow || view.log || view.dismiss || view.accept ? (
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            {view.accept ? (
              <>
                <button type="button" disabled={busy} onClick={() => act("record the answer", () => acceptShip(view.id, "yes"))} className="rounded-md bg-content/8 px-2.5 py-1 text-content hover:bg-content/12 disabled:opacity-50">
                  Yes, it works
                </button>
                <button type="button" disabled={busy} onClick={() => act("record the answer", () => acceptShip(view.id, "no"))} className="rounded-md px-2.5 py-1 text-content/70 hover:bg-content/5 hover:text-content">
                  Something's wrong
                </button>
              </>
            ) : null}
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
