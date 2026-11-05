import { expect, test } from "vitest";
import { workingLabel } from "./working";

test("working time is words, and a bad clock does not throw", () => {
  const start = 1_700_000_000_000;
  expect(workingLabel(start, start + 20_000)).toBe("Under a minute");
  expect(workingLabel(start, start + 5 * 60_000)).toBe("5 min");
  expect(workingLabel(start, start + 125 * 60_000)).toBe("2 h 5 min");
  expect(workingLabel(start, start - 1)).toBe("Under a minute");
  expect(workingLabel(Number.NaN, start)).toBe("Under a minute");
});
