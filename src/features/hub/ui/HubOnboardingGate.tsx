import { useEffect, useState } from "react";
import { usePagesVersion } from "../../pages/model/pages";
import { markFreshSetup, seedReadyPages } from "../../pages/model/readyPagesSeed";
import { needsOnboarding } from "../model/onboarding";
import { checkHubSetup, defaultWorkFolders, setupCardSnoozed, setupProved } from "../model/setupProof";
import { hubData } from "../model/hubData";
import { HubOnboarding } from "./HubOnboarding";
import { ensureBuiltInMonos } from "../model/builtInMonos";
import { isDevCopy } from "../../../app/model/appIdentity";
import { ImportSetupHost } from "../../chatImport/ui/ImportSetupHost";

/** What the gate does at launch: show the card, check setup quietly first, or stay away. */
export type OnboardingGate = "show" | "check" | "hide";

/**
 * The welcome steps show once, on a first launch. After that the card never opens just because a check was not yet
 * written down (0.16.3 opened it on every launch): the checks run quietly, and the card opens only when one really
 * fails. "Not now", or closing a passed card, is remembered and keeps it away. A dev copy starts with fresh data every
 * time an agent tests it, so it never shows the card unless asked (`?onboarding`).
 */
export function onboardingGate(dev: boolean = isDevCopy(), proved: boolean = setupProved(), snoozed: boolean = setupCardSnoozed(), first: boolean = needsOnboarding()): OnboardingGate {
  if (dev && !new URLSearchParams(window.location.search).has("onboarding")) return "hide";
  if (snoozed) return "hide";
  if (first) return "show";
  return proved ? "hide" : "check";
}

/** Whether the card opens straight away at launch (the quiet check may still open it later). */
export function showsOnboarding(dev: boolean = isDevCopy(), proved: boolean = setupProved(), snoozed: boolean = setupCardSnoozed(), first: boolean = needsOnboarding()): boolean {
  return onboardingGate(dev, proved, snoozed, first) === "show";
}

/** Runs the setup checks without a card; true when one of them really fails (so the card has something to fix). */
export async function setupNeedsCard(check: typeof checkHubSetup = checkHubSetup): Promise<boolean> {
  let knownFolders: string[] = [];
  try {
    knownFolders = hubData()
      .listProjects()
      .map((project) => project.folder)
      .filter((path): path is string => Boolean(path));
  } catch {
    /* no projects yet */
  }
  try {
    const run = await check({ knownFolders, fallbackFolders: await defaultWorkFolders() });
    return !run.proved;
  } catch {
    return false;
  }
}

/** Shows the card on first launch, and later only when a quiet setup check fails, until Ash dismisses it. */
export function HubOnboardingGate() {
  const [gate] = useState<OnboardingGate>(() => {
    // First launch: the roster starts with the built-in Monos only. At first render, not at import, so the roster from
    // the Monos' home is back first and an existing install is never taken for a fresh one (teamPack.ts).
    if (needsOnboarding()) {
      ensureBuiltInMonos();
      // C8: a fresh setup comes with the four ready-made dashboards.
      markFreshSetup();
    }
    return onboardingGate();
  });
  const [open, setOpen] = useState(gate === "show");
  useEffect(() => {
    if (gate !== "check") return;
    let live = true;
    void setupNeedsCard().then((needs) => {
      if (live && needs) setOpen(true);
    });
    return () => {
      live = false;
    };
  }, [gate]);
  const pagesVersion = usePagesVersion();
  useEffect(() => {
    void seedReadyPages();
  }, [pagesVersion]);
  return (
    <>
      {open ? <HubOnboarding onClose={() => setOpen(false)} /> : null}
      {/* Bringing chats over carries on after first run closes, and calls the person back for its later parts. */}
      {open ? null : <ImportSetupHost />}
    </>
  );
}
