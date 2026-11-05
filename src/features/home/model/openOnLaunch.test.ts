import { expect, it } from "vitest";
import { chooseOpening } from "./openOnLaunch";

it("opens home only when something needs the person and they have not already gone somewhere", () => {
  expect(chooseOpening({ needsYou: 2, navigated: false })).toBe("home");
  expect(chooseOpening({ needsYou: 1, navigated: false })).toBe("home");
  expect(chooseOpening({ needsYou: 0, navigated: false })).toBe("stay");
  expect(chooseOpening({ needsYou: 4, navigated: true })).toBe("stay");
  expect(chooseOpening({ needsYou: Number.NaN, navigated: false })).toBe("stay");
  expect(chooseOpening({ needsYou: -1, navigated: false })).toBe("stay");
  expect(chooseOpening({ needsYou: Number.POSITIVE_INFINITY, navigated: false })).toBe("stay");
});
