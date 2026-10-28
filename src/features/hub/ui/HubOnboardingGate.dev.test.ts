// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { showsOnboarding } from "./HubOnboardingGate";
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

  // H7: the welcome choices are one-time, but the card keeps coming back until setup is proved for real.
  it("returns on the daily app after the choices when setup is not proved", () => {
    finishOnboarding();
    expect(showsOnboarding(false)).toBe(true);
  });

  it("stays away once every setup check has passed", () => {
    finishOnboarding();
    for (const id of SETUP_FACT_IDS) recordSetupFact(id, "proved");
    expect(showsOnboarding(false)).toBe(false);
  });

  // r61 (PM's blind run on 0.16.2): "Not now" on the setup card came back on every launch.
  it("stays away on later launches once Ash said Not now, proved or not", () => {
    finishOnboarding();
    expect(showsOnboarding(false)).toBe(true);
    snoozeSetupCard();
    expect(showsOnboarding(false)).toBe(false);
  });
});
