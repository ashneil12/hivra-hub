import { expect, it } from "vitest";

// Glass (hsl 240 0% 9%), content at 92% lightness; an unselected row is drawn at 65% opacity.
it("the grey role text is 4.5:1 or better on glass, even on a dimmed row", async () => {
  const { contrast, hslToRgb } = await import("../../features/settings/model/themeSchemes");
  const bg = hslToRgb(240, 0, 9);
  const fg = hslToRgb(240, 0, 92);
  const at = (alpha: number) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as [number, number, number];
  expect(contrast(at(0.8 * 0.65), bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(at(0.8), bg)).toBeGreaterThanOrEqual(4.5);
});
