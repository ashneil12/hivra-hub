import { useState } from "react";
import { needsOnboarding } from "../model/onboarding";
import { HubOnboarding } from "./HubOnboarding";
import { ensureBuiltInMonos } from "../model/builtInMonos";
import { isDevCopy } from "../../../app/model/appIdentity";

// First launch: the roster starts with the built-in Monos only.
if (needsOnboarding()) ensureBuiltInMonos();

/** Whether to show the welcome steps: once, on the daily app's first launch. A dev copy starts with fresh data every
 *  time an agent tests it, so it never shows them unless asked (`?onboarding`); Ash saw them pop up again and again. */
export function showsOnboarding(dev: boolean = isDevCopy()): boolean {
  if (dev && !new URLSearchParams(window.location.search).has("onboarding"))
    return false;
  return needsOnboarding();
}

/** Shows onboarding once, on first launch. */
export function HubOnboardingGate() {
  const [open, setOpen] = useState(() => showsOnboarding());
  return open ? <HubOnboarding onClose={() => setOpen(false)} /> : null;
}
