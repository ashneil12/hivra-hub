import { useState } from "react";
import { needsOnboarding } from "../model/onboarding";
import { HubOnboarding } from "./HubOnboarding";
import { ensureBuiltInMonos } from "../model/builtInMonos";

// First launch: the roster starts with the built-in Monos only.
if (needsOnboarding()) ensureBuiltInMonos();

/** Shows onboarding once, on first launch. */
export function HubOnboardingGate() {
  const [open, setOpen] = useState(needsOnboarding);
  return open ? <HubOnboarding onClose={() => setOpen(false)} /> : null;
}
