// r99 (B5 df53): the Lead's "Fixed:" / "Right:" self-corrections came four in a row. The early-claim check now asks for
// one plain line with no label, so the correction doesn't read as a new "Fixed" claim and set off the next check.
import { expect, it } from "vitest";
import { CHECK_RULES } from "./checkerRules";
import { EARLY_RULES } from "./askSettle";

it("asks for a plain correction, not a Right:/Fixed: line", () => {
  expect(EARLY_RULES).toMatch(/one plain line, with no "Right:" or "Fixed:" label/);
  expect(EARLY_RULES).not.toBe(CHECK_RULES);
});
