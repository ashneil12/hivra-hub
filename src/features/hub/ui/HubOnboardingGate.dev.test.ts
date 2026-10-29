// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { onboardingGate, setupNeedsCard, showsOnboarding } from "./HubOnboardingGate";
import { finishOnboarding } from "../model/onboarding";
import { recordSetupFact, SETUP_FACT_IDS, snoozeSetupCard } from "../model/setupProof";

describe("onboarding in a dev copy", () => {
  afterEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("never shows in a dev copy, which starts with fresh data on every agent test", () => {
    expect(showsOnboarding(true)).toBe(false);
  });

  it("still shows once in the daily app", () => {
    expect(showsOnboarding(false)).toBe(true);
  });

  it("can be asked for in a dev copy with ?onboarding", () => {
    window.history.replaceState(null, "", "/?onboarding");
    expect(showsOnboarding(true)).toBe(true);
  });

  // r62 (Critiquito, 0.16.3 blocker): after the welcome choices, the card no longer opens on launch just because a check
  // was not written down; the checks run quietly first, and the card opens only when one really fails.
  it("checks quietly after the choices when setup is not proved, instead of opening the card", () => {
    finishOnboarding();
    expect(showsOnboarding(false)).toBe(false);
    expect(onboardingGate(false)).toBe("check");
  });

  it("opens the card only when the quiet check really fails", async () => {
    const run = (proved: boolean) => async () => ({ proved, checks: [] });
    expect(await setupNeedsCard(run(true))).toBe(false);
    expect(await setupNeedsCard(run(false))).toBe(true);
    expect(await setupNeedsCard(async () => { throw new Error("no CLI"); })).toBe(false);
  });

  it("stays away once every setup check has passed", () => {
    finishOnboarding();
    for (const id of SETUP_FACT_IDS) recordSetupFact(id, "proved");
    expect(showsOnboarding(false)).toBe(false);
    expect(onboardingGate(false)).toBe("hide");
  });

  // r61 (PM's blind run on 0.16.2): "Not now" on the setup card came back on every launch.
  it("stays away on later launches once Ash said Not now, proved or not", () => {
    finishOnboarding();
    expect(onboardingGate(false)).toBe("check");
    snoozeSetupCard();
    expect(onboardingGate(false)).toBe("hide");
  });
});
