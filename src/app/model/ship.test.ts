import { describe, expect, it } from "vitest";
import { NO_SHIP, readShipStatus, shipCardView, type ShipStatus } from "./ship";

const ID = "20261019-210405-bbbbbbb";
const builds = {
  from: { sha: "a".repeat(40), branch: "hub/next" },
  to: { sha: "b".repeat(40), branch: "hub/1b-ship" },
};

function status(current: Record<string, unknown> | null, extra: Record<string, unknown> = {}): ShipStatus {
  return readShipStatus({
    enabled: true,
    holding: false,
    trial: null,
    pending: null,
    current: current && { id: ID, accepted: false, committed: false, seen: false, log: "/ship/runner.log", ...builds, ...current },
    ...extra,
  });
}

describe("ship status from the app", () => {
  it("reads loosely and falls back to nothing", () => {
    expect(readShipStatus(null)).toEqual(NO_SHIP);
    expect(readShipStatus("nope")).toEqual(NO_SHIP);
    const read = status({ phase: "trial", requestedBy: { sessionId: "lead", via: "app.ship" }, extra: 1 });
    expect(read.current).toMatchObject({ id: ID, phase: "trial", requestedBy: { sessionId: "lead" }, to: { branch: "hub/1b-ship" } });
    expect(readShipStatus({ enabled: true, current: { id: 3 } }).current).toBeNull();
  });
});

describe("what Today says about a ship", () => {
  it("says nothing outside the daily app or with no ship", () => {
    expect(shipCardView(NO_SHIP)).toBeNull();
    expect(shipCardView(status(null))).toBeNull();
    expect(shipCardView({ ...status({ phase: "committed" }), enabled: false })).toBeNull();
  });

  it("explains the trial while this build holds", () => {
    const view = shipCardView(status({ phase: "trial" }, { holding: true, trial: { id: ID, committed: false } }));
    expect(view?.text).toBe("Checking the new build.");
    expect(view?.restartNow).toBeUndefined();
  });

  it("offers Restart now for an accepted update that waits for a quiet moment", () => {
    const view = shipCardView(
      status({ phase: "waiting", accepted: true, deferred: { inFlight: 2 } }, { pending: { id: ID, force: false } }),
    );
    expect(view).toMatchObject({ text: "An update to MonoCode Hub is ready.", restartNow: true });
    expect(view?.text).not.toMatch(/@|bbbbbbb|hub\//);
    expect(view?.detail).toContain("(2 running now)");
  });

  it("says each receipt in plain words, with no branch or commit; a committed update is shown once, the rest until read", () => {
    const committed = shipCardView(status({ phase: "committed" }));
    expect(committed).toMatchObject({ text: "MonoCode Hub was updated.", log: "/ship/runner.log", once: true });
    expect(committed?.dismiss).toBeUndefined();
    const rolled = shipCardView(status({ phase: "rolled-back", reason: "The new build didn't commit within 120 s." }));
    expect(rolled?.text).toBe("An update was rolled back. The new build didn't commit within 120 s.");
    expect(rolled?.detail).toBe("Back on the build before it, with the database as it was.");
    expect(rolled?.dismiss).toBe(true);
    for (const phase of ["committed", "rolled-back", "cancelled", "failed"])
      expect(JSON.stringify([shipCardView(status({ phase, reason: "r" }))?.text, shipCardView(status({ phase, reason: "r" }))?.detail])).not.toMatch(/ @ |aaaaaaa|bbbbbbb|hub\/next|hub\/1b-ship/);
    expect(shipCardView(status({ phase: "cancelled", reason: "Refused." }))?.detail).toBe("Nothing changed.");
    expect(shipCardView(status({ phase: "failed", reason: "x", shipDir: "/ship" }))?.detail).toContain("/ship");
    expect(shipCardView(status({ phase: "committed", seen: true }))).toBeNull();
    // Mid-swap there is nothing to say yet (and nothing to press).
    expect(shipCardView(status({ phase: "swapping" }))).toBeNull();
  });
});

describe("a build on trial holds from its first render", () => {
  it("reads the hold the app handed the window before its scripts ran", async () => {
    const { vi } = await import("vitest");
    const global = globalThis as Record<string, unknown>;
    global.__MONOCODE_APP__ = { kind: "daily", ship: { holding: true, trial: { id: ID, committed: false } } };
    try {
      vi.resetModules();
      const fresh = await import("./ship");
      expect(fresh.shipStatus()).toMatchObject({ enabled: true, holding: true, trial: { id: ID } });
    } finally {
      delete global.__MONOCODE_APP__;
      vi.resetModules();
    }
    const plain = await import("./ship");
    expect(plain.shipStatus().holding).toBe(false);
  });
});
