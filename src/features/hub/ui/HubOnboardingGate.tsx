import { useState } from "react";
import { needsOnboarding } from "../model/onboarding";
import { HubOnboarding } from "./HubOnboarding";

/** Shows onboarding once, on first launch. */
export function HubOnboardingGate() {
  const [open, setOpen] = useState(needsOnboarding);
  return open ? <HubOnboarding onClose={() => setOpen(false)} /> : null;
}
