import { useEffect, useState } from "react";
import { usePagesVersion } from "../../pages/model/pages";
import { markFreshSetup, seedReadyPages } from "../../pages/model/readyPagesSeed";
import { needsOnboarding } from "../model/onboarding";
import { setupCardSnoozed, setupProved } from "../model/setupProof";
import { HubOnboarding } from "./HubOnboarding";
import { ensureBuiltInMonos } from "../model/builtInMonos";
import { isDevCopy } from "../../../app/model/appIdentity";

/** Whether to show the first-launch card: the welcome steps once, and the setup checks until they are proved. A dev
 *  copy starts with fresh data every time an agent tests it, so it never shows the card unless asked (`?onboarding`);
 *  Ash saw it pop up again and again. The card itself decides which of the two it shows. */
export function showsOnboarding(dev: boolean = isDevCopy(), proved: boolean = setupProved(), snoozed: boolean = setupCardSnoozed()): boolean {
  if (dev && !new URLSearchParams(window.location.search).has("onboarding"))
    return false;
  // r61: once Ash said "Not now", the card stays away (it came back on every launch of 0.16.2 in PM's blind run).
  if (snoozed) return false;
  return needsOnboarding() || !proved;
}

/** Shows the card on first launch, and on any launch where setup is not yet proved, until Ash says "Not now". */
export function HubOnboardingGate() {
  const [open, setOpen] = useState(() => {
    // First launch: the roster starts with the built-in Monos only. At first render, not at import, so the roster from
    // the Monos' home is back first and an existing install is never taken for a fresh one (teamPack.ts).
    if (needsOnboarding()) {
      ensureBuiltInMonos();
      // C8: a fresh setup comes with the four ready-made dashboards.
      markFreshSetup();
    }
    return showsOnboarding();
  });
  const pagesVersion = usePagesVersion();
  useEffect(() => {
    void seedReadyPages();
  }, [pagesVersion]);
  return open ? <HubOnboarding onClose={() => setOpen(false)} /> : null;
}
