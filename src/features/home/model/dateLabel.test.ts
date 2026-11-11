import { expect, it } from "vitest";
import { homeDateLabel } from "./dateLabel";

it("writes the day the way the header does, with no comma", () => {
  expect(homeDateLabel(new Date(2026, 10, 11))).toBe("Wednesday 11 November");
  expect(homeDateLabel(new Date(Number.NaN))).toBe("");
});
