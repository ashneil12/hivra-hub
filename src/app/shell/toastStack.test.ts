import { describe, expect, it } from "vitest";
import { TOAST_STACK_TOP, toastStackTop } from "./toastStack";

describe("the top-right notice stack", () => {
  it("starts below the 40px top bar, so a notice's X is never in the title-bar strip or over the header's buttons", () => {
    expect(TOAST_STACK_TOP).toBeGreaterThanOrEqual(40 + 8);
    expect(toastStackTop([])).toBe(48);
  });
  it("puts each notice under the shown ones above it with an 8px gap; hidden ones take no room", () => {
    expect(toastStackTop([0, 0])).toBe(48);
    expect(toastStackTop([100])).toBe(156);
    expect(toastStackTop([100, 0, 50])).toBe(214);
  });
});
