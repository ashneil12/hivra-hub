// One look when the app opens. Home if something needs the person, otherwise where they were.
// A failed look tries again. It is not "nothing needs you", and it does not keep redirecting after they move.

import { useEffect, useRef } from "react";
import { hubDefaultsOn } from "../../hub/model/hubDefaults";
import { currentHubSelection, showAppItem, subscribeHubSelection } from "../../hub/model/hubNav";
import { loadNeedsYouCount, realHomeSource } from "../model/load";
import { chooseOpening } from "../model/openOnLaunch";

const defaultLoad = () => loadNeedsYouCount(realHomeSource());

export function useHomeOnOpen(load: () => Promise<number> = defaultLoad, retryMs = 2000): void {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!hubDefaultsOn()) return;
    const start = currentHubSelection();
    let stopped = false;
    let moved = false;
    let timer = 0;
    const stopWatch = subscribeHubSelection(() => {
      const now = currentHubSelection();
      if (now.project !== start.project || now.item !== start.item) moved = true;
    });
    const attempt = () => {
      if (stopped || moved) return;
      const now = currentHubSelection();
      if (now.project !== start.project || now.item !== start.item) return;
      loadRef.current().then((count) => {
        if (stopped) return;
        const later = currentHubSelection();
        const navigated = moved || later.project !== start.project || later.item !== start.item;
        if (chooseOpening({ needsYou: count, navigated }) === "home") showAppItem("home");
      }).catch(() => {
        if (!stopped && !moved) timer = window.setTimeout(attempt, retryMs);
      });
    };
    attempt();
    return () => {
      stopped = true;
      stopWatch();
      window.clearTimeout(timer);
    };
  }, [retryMs]);
}
