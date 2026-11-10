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

  it("keeps Ash's answer, and a missing or unknown one is pending", () => {
    expect(status({ phase: "committed" }).current?.acceptance).toEqual({ state: "pending" });
    expect(status({ phase: "committed", acceptance: { state: "yes" } }).current?.acceptance).toEqual({ state: "yes" });
    expect(status({ phase: "committed", acceptance: { state: "no", note: "Crashes on launch." } }).current?.acceptance).toEqual({
      state: "no",
      note: "Crashes on launch.",
    });
    for (const value of [null, "yes", { state: "maybe" }, { state: true }])
      expect(status({ phase: "committed", acceptance: value }).current?.acceptance).toEqual({ state: "pending" });
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

  it("asks Ash whether the update works, naming the version and no ids; nothing calls it accepted before he answers", () => {
    // r63 (Critiquito): "shipped afe42a3 from main (ship …)" became the version alone.
    const view = shipCardView(status({ phase: "committed" }), "0.16.5");
    expect(view).toMatchObject({ text: "Hivra updated to 0.16.5. Is everything working?", accept: true });
    expect(view?.detail).toBeUndefined();
    expect(view?.text).not.toMatch(/bbbbbbb|hub\/1b-ship|shipped/);
    expect(shipCardView(status({ phase: "committed" }))?.text).toBe("Hivra was updated. Is everything working?");
    expect(view?.once).toBeUndefined();
    expect(view?.dismiss).toBeUndefined();
    // A receipt already read doesn't answer it: the question stays until he does.
    expect(shipCardView(status({ phase: "committed", seen: true }))?.accept).toBe(true);
  });

  it("shows the update once he says it works, and notes a no until it's read", () => {
    const yes = shipCardView(status({ phase: "committed", acceptance: { state: "yes" } }));
    expect(yes).toMatchObject({ text: "MonoCode Hub was updated.", log: "/ship/runner.log", once: true });
    expect(yes?.accept).toBeUndefined();
    expect(yes?.dismiss).toBeUndefined();
    expect(JSON.stringify([yes?.text, yes?.detail])).not.toMatch(/ @ |aaaaaaa|bbbbbbb|hub\/next|hub\/1b-ship/);
    expect(shipCardView(status({ phase: "committed", acceptance: { state: "yes" }, seen: true }))).toBeNull();
    const no = shipCardView(status({ phase: "committed", acceptance: { state: "no", note: "Crashes on launch." } }));
    expect(no).toMatchObject({ text: "Noted: something's wrong with this build. Crashes on launch.", dismiss: true });
    expect(no?.accept).toBeUndefined();
    expect(no?.log).toBe("/ship/runner.log");
    expect(no?.detail).toBe(`The answer is kept with ship ${ID}.`);
    expect(shipCardView(status({ phase: "committed", acceptance: { state: "no" }, seen: true }))).toBeNull();
  });

  it("says each receipt in plain words, with no branch or commit; the rest until read", () => {
    const rolled = shipCardView(status({ phase: "rolled-back", reason: "The new build didn't commit within 120 s." }));
    expect(rolled?.text).toBe("An update was rolled back. The new build didn't commit within 120 s.");
    expect(rolled?.detail).toBe("Back on the build before it, with the database as it was.");
    expect(rolled?.dismiss).toBe(true);
    for (const phase of ["rolled-back", "cancelled", "failed"])
      expect(JSON.stringify([shipCardView(status({ phase, reason: "r" }))?.text, shipCardView(status({ phase, reason: "r" }))?.detail])).not.toMatch(/ @ |aaaaaaa|bbbbbbb|hub\/next|hub\/1b-ship/);
    expect(shipCardView(status({ phase: "cancelled", reason: "Refused." }))?.detail).toBe("Nothing changed.");
    expect(shipCardView(status({ phase: "failed", reason: "x", shipDir: "/ship" }))?.detail).toContain("/ship");
    expect(shipCardView(status({ phase: "rolled-back", seen: true }))).toBeNull();
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
