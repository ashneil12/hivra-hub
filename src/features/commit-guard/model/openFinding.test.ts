// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { onGuardFindingOpen, openGuardFinding, takePendingGuardFinding } from "./openFinding";

const finding = "Possible secret in src/config.rs:12. The value is not shown.";

afterEach(() => {
  takePendingGuardFinding();
});

describe("openGuardFinding", () => {
  it("holds a commit-guard refusal for the source-control panel and tells the app to show it", () => {
    const shown = vi.fn();
    const off = onGuardFindingOpen(shown);
    openGuardFinding(finding);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(takePendingGuardFinding()).toBe(finding);
    expect(takePendingGuardFinding()).toBeNull();
    off();
  });

  it("ignores a message that is not a guard refusal", () => {
    openGuardFinding("git push failed: rejected");
    expect(takePendingGuardFinding()).toBeNull();
  });

  it("stops telling the app once its listener is removed", () => {
    const shown = vi.fn();
    const off = onGuardFindingOpen(shown);
    off();
    openGuardFinding(finding);
    expect(shown).not.toHaveBeenCalled();
  });
});
