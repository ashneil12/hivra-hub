// @vitest-environment happy-dom
// WP-176: a spend limit travels with the setup, and an import never raises one that is already here.
import { beforeEach, describe, expect, it } from "vitest";
import { buildSetupDoc } from "../../portable/model/setupDoc";
import { SPEND_LIMITS_KEY } from "./spend";
import { resetSpendGate, saveSpendLimit, spendSnapshot, takeImportedSpend } from "./spendGate";

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
});

describe("export and import of spend limits", () => {
  it("carries a limit that was set, and leaves the key out when none is", () => {
    const empty = buildSetupDoc({ monoFiles: {}, workspace: false });
    expect(empty.settings[SPEND_LIMITS_KEY]).toBeUndefined();
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 40, warnAt: 0.8 }, 0);
    const doc = buildSetupDoc({ monoFiles: {}, workspace: false });
    const carried = JSON.parse(doc.settings[SPEND_LIMITS_KEY] ?? "null") as { limits: { amountUsd: number }[] };
    expect(carried.limits).toEqual([
      expect.objectContaining({ scope: "project", project: "hivra", period: "month", amountUsd: 40, warnAt: 0.8 }),
    ]);
    expect(JSON.stringify(carried)).not.toContain("measuredUsd");
  });

  it("adds a missing limit and never raises one, even when the file asks for more", () => {
    saveSpendLimit({ scope: "project", project: "hivra", period: "month", amountUsd: 40, warnAt: 0.8 }, 0);
    const higher = takeImportedSpend({
      revision: 0,
      limits: [{ scope: "project", project: "hivra", period: "month", amountUsd: 80, warnAt: 0.9 }],
    });
    expect(higher.limits[0]).toMatchObject({ amountUsd: 40, warnAt: 0.8 });
    const lower = takeImportedSpend({
      revision: 9,
      limits: [{ scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.5 }],
    });
    expect(lower.limits[0]).toMatchObject({ amountUsd: 10, warnAt: 0.5 });
    resetSpendGate();
    const added = takeImportedSpend({
      revision: 3,
      limits: [{ scope: "app", period: "day", amountUsd: 5, warnAt: 0.8 }],
    });
    expect(added.limits).toEqual([
      expect.objectContaining({ scope: "app", project: "", period: "day", amountUsd: 5 }),
    ]);
    expect(spendSnapshot().book.limits).toHaveLength(1);
    const junk = takeImportedSpend({ limits: [{ scope: "mono", amountUsd: 1 }] });
    expect(junk.limits).toHaveLength(1);
  });
});
