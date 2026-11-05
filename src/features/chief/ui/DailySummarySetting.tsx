// WP-88: the morning note on Home. Off is the only state this stores.

import { useEffect, useState } from "react";
import { browserStorage, changeHome, readHome } from "../../home/model/store";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { withDailySummary } from "../model/summary";

/** The switch in Settings. A write that does not land leaves the switch where it was. */
export function DailySummarySetting() {
  const [on, setOn] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stopped = false;
    void readHome(tauriLocalHubDisk, browserStorage())
      .then((home) => {
        if (!stopped) setOn(home.doc.dailySummary !== false);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setReady(true);
      });
    return () => {
      stopped = true;
    };
  }, []);
  return (
    <button
      type="button"
      role="switch"
      aria-label="Morning summary"
      aria-checked={on}
      disabled={!ready}
      className="text-[13px] text-content underline-offset-2 hover:underline disabled:opacity-50"
      onClick={() => {
        const next = !on;
        void changeHome(tauriLocalHubDisk, browserStorage(), (doc) => withDailySummary(doc, next)).then((written) => {
          if (!written) return;
          setOn(written.doc.dailySummary !== false);
        });
      }}
    >
      {on ? "On" : "Off"}
    </button>
  );
}
