// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { showsOnboarding } from "./HubOnboardingGate";

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
});
