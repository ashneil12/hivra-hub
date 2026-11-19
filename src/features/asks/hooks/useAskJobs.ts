// A job's end reaches its ask (README gap D5), in the Hub bundle's main window only (so two windows never apply one end
// twice: the write is revision-checked anyway). Whenever the delegation rows change (the feed refreshes them on every
// change, monos/model/delegationStore.ts) the rows are applied to the ask ledger in one write (askStore.jobs, askJobs.ts):
// started while a job works, done with its proof when it passed, back to heard with a note when it failed or was cancelled.
//
// It reads the rows as they stand, so a job that ended while this window was closed is applied at the next start, and the
// same rows applied again change nothing. A row that has left the recent list (delegations_recent) is not seen again: an
// ask whose job ended that long ago and was never applied stays as it was, and the daily check (askNotes.ts) names it.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { delegationRows, subscribeDelegations } from "../../monos/model/delegationStore";
import { isLedgerAskId } from "../model/asks";
import { askStore } from "../model/askStore";

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function useAskJobs(enabled: boolean): void {
  const on = enabled && isMainWindow();
  useEffect(() => {
    if (!on) return;
    const store = askStore();
    let running = false;
    let again = false;
    // One write at a time; a change that lands meanwhile runs once more with the rows as they are then.
    const apply = () => {
      if (running) {
        again = true;
        return;
      }
      // Most changes carry no ask at all: nothing to read or write then.
      if (!delegationRows().some((row) => row.askIds?.some(isLedgerAskId))) return;
      running = true;
      void store
        .load()
        .then(() => store.jobs(delegationRows()))
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (again) {
            again = false;
            apply();
          }
        });
    };
    apply();
    return subscribeDelegations(apply);
  }, [on]);
}
