import { afterEach, expect, it, vi } from "vitest";
import { ONE_TAP_NOTICE_MS, noteOneTapRefusal, oneTapRefusal, resetOneTapRefusal } from "./oneTapNotice";

afterEach(() => {
  vi.useRealTimers();
  resetOneTapRefusal();
});

it("shows the reason it was given, not that the row changed", () => {
  noteOneTapRefusal("The agent didn't suggest an answer. Reply in your words or open the chat.");
  expect(oneTapRefusal()).toBe("The agent didn't suggest an answer. Reply in your words or open the chat.");
  noteOneTapRefusal("That chat isn't waiting any more.");
  expect(oneTapRefusal()).toBe("That chat isn't waiting any more.");
});

it("does not turn a blank or enormous reason into the changed sentence", () => {
  noteOneTapRefusal("   ");
  expect(oneTapRefusal()).not.toBe("That changed while you were looking");
  expect(oneTapRefusal()).toBe("That didn't go through. Try again.");
  const huge = "Cannot answer. ".repeat(40);
  noteOneTapRefusal(huge);
  const shown = oneTapRefusal() ?? "";
  expect(shown.length).toBeLessThan(huge.length);
  expect(shown.endsWith("...")).toBe(true);
  expect(shown.startsWith("Cannot answer.")).toBe(true);
  expect(shown).not.toContain("\n");
});

it("clears the notice after a while, and not straight away", () => {
  vi.useFakeTimers();
  noteOneTapRefusal("Hold this.");
  expect(oneTapRefusal()).toBe("Hold this.");
  vi.advanceTimersByTime(1_000);
  expect(oneTapRefusal()).toBe("Hold this.");
  vi.advanceTimersByTime(ONE_TAP_NOTICE_MS);
  expect(oneTapRefusal()).toBeUndefined();
});

it("a repeated refusal stays up for another while", () => {
  vi.useFakeTimers();
  noteOneTapRefusal("Hold this.");
  vi.advanceTimersByTime(ONE_TAP_NOTICE_MS - 1_000);
  expect(oneTapRefusal()).toBe("Hold this.");
  noteOneTapRefusal("Hold this.");
  vi.advanceTimersByTime(ONE_TAP_NOTICE_MS - 1_000);
  expect(oneTapRefusal()).toBe("Hold this.");
  vi.advanceTimersByTime(1_000);
  expect(oneTapRefusal()).toBeUndefined();
});
