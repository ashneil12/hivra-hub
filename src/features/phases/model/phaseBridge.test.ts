import { expect, it } from "vitest";
import { deliverPhaseResult, isPhaseSession, phaseFinish, waitForPhaseResult } from "./phaseBridge";

it("gives a reply to the wait, and ignores one that arrives after the wait ended", async () => {
  const pending = waitForPhaseResult("phase-late", 40);
  const late = await pending;
  expect(late).toEqual({ timedOut: true });
  deliverPhaseResult("phase-late", { body: "too late" });

  const next = waitForPhaseResult("phase-late", 1_000);
  deliverPhaseResult("phase-late", { body: "The save drops the last line." });
  expect(await next).toEqual({ body: "The save drops the last line." });
});

it("settles the first wait when a second one takes the same session", async () => {
  const first = waitForPhaseResult("phase-two", 1_000);
  const second = waitForPhaseResult("phase-two", 1_000);
  expect(await first).toEqual({ unreachable: true });
  deliverPhaseResult("phase-two", { body: "kept" });
  expect(await second).toEqual({ body: "kept" });
});

it("reads a reply as a document, and a failure with no text as not finished", () => {
  expect(phaseFinish("failed", "A fact about the code.")).toEqual({ body: "A fact about the code." });
  expect(phaseFinish("completed", "  ")).toEqual({ body: "" });
  expect(phaseFinish("failed", "")).toEqual({ unreachable: true });
  expect(phaseFinish("cancelled", "")).toEqual({ unreachable: true });
  expect(isPhaseSession("app-mono-r1-phase-phase-1")).toBe(true);
  expect(isPhaseSession("app-mono-r1")).toBe(false);
});
