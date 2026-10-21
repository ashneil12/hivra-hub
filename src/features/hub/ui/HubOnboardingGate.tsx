import { useState } from "react";
import { needsOnboarding } from "../model/onboarding";
import { HubOnboarding } from "./HubOnboarding";
import { ensureBuiltInMonos } from "../model/builtInMonos";
import { isDevCopy } from "../../../app/model/appIdentity";

/** Whether to show the welcome steps: once, on the daily app's first launch. A dev copy starts with fresh data every
 *  time an agent tests it, so it never shows them unless asked (`?onboarding`); Ash saw them pop up again and again. */
export function showsOnboarding(dev: boolean = isDevCopy()): boolean {
  if (dev && !new URLSearchParams(window.location.search).has("onboarding"))
    return false;
  return needsOnboarding();
}

/** Shows onboarding once, on first launch. */
export function HubOnboardingGate() {
  const [open, setOpen] = useState(() => {
    // First launch: the roster starts with the built-in Monos only. At first render, not at import, so the roster from
    // the Monos' home is back first and an existing install is never taken for a fresh one (teamPack.ts).
    if (needsOnboarding()) ensureBuiltInMonos();
    return showsOnboarding();
  });
  return open ? <HubOnboarding onClose={() => setOpen(false)} /> : null;
}
