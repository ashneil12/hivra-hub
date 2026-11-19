// Settings → Export and import → "Bring over from Ash OS" (WP-04 review): the one-time import, run again by hand. On
// start the app asks only once and keeps the answer; this runs it whatever was decided before. It only ever adds, and
// Ash OS is only read (localHub/ashOsImport.ts).
import { useEffect, useState } from "react";
import { appHubTransport } from "../model/localHub/localTransport";
import { importFromAshOsAgain, importOutcome, offersAshOsImport, type ImportDeps } from "../model/localHub/ashOsImport";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export function AshOsImportButton({ deps }: { deps?: ImportDeps }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  // Hidden once the app knows there's no Ash OS here (most people never had one); shown again after a run here.
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let live = true;
    void offersAshOsImport(appHubTransport().hub).then((yes) => live && setOffered(yes));
    return () => {
      live = false;
    };
  }, []);
  const run = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(importOutcome(await importFromAshOsAgain(appHubTransport().hub, deps)));
    } catch (error) {
      setOutcome(`It didn't finish: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  if (!offered && !outcome) return null;
  return (
    <div className="flex flex-col gap-1 px-3 pt-3" data-ash-os-import>
      <span className="text-[13px] leading-5 text-content/60">
        Projects, which Monos work on them, and kept Hubs from Ash OS, if it still runs on this Mac. Only adds; Ash OS isn't changed.
      </span>
      <span className="flex items-center gap-2">
        <button type="button" data-ash-os-import-run onClick={() => void run()} className={BTN} disabled={busy}>
          {busy ? "Asking Ash OS…" : "Bring over from Ash OS…"}
        </button>
        {outcome ? <span className="text-[13px] text-content/75" data-ash-os-import-outcome>{outcome}</span> : null}
      </span>
    </div>
  );
}
