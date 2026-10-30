// r92 (s15 scripted dcf4): the worker card in the chat said Stalled while its row in the Sessions panel said "Working...".
import { expect, it } from "vitest";
import { launchState, sessionStalled } from "./delegationView";

it("the Sessions panel row reads the worker's row as its card does: Stalled, not Working", () => {
  const stalled = { state: "running" as const, stallKind: "quiet" as const };
  expect(launchState({ state: "working", title: "Show tally count" }, stalled)).toBe("stuck");
  expect(sessionStalled(true, stalled)).toBe(true);
  expect(sessionStalled(false, stalled)).toBe(true);
  expect(sessionStalled(true, { state: "running" as const })).toBe(false);
  expect(sessionStalled(true, { state: "completed" as const, stallKind: "quiet" as const })).toBe(false);
  expect(sessionStalled(true, undefined)).toBe(false);
});
