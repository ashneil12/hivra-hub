import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const src = readFileSync(new URL("./MonoRailSection.tsx", import.meta.url), "utf8");

it("in a narrow sidebar the role name truncates first and the grey own name never does", () => {
  expect(src).toMatch(/className="min-w-0 truncate text-sm font-medium @max-\[200px\]\/monorail:hidden" data-mono-primary-name/);
  expect(src).toMatch(/className="shrink-0 text-xs font-normal text-content\/80 [^"]*" data-mono-own-name/);
});

it("G4: with names first, the name has the whole first row and the grey role is a second line at every width", () => {
  expect(src).toMatch(/className="truncate text-sm font-medium leading-\[18px\]" data-mono-primary-name/);
  expect(src).toMatch(/className="truncate text-\[11px\] font-normal leading-\[14px\] text-content\/80" data-mono-role/);
  expect(src).not.toMatch(/monorail:hidden" data-mono-role/);
  expect(src).toMatch(/\$\{twoLines \? "h-\[38px\]" : "h-8"\}/);
});

// Glass (hsl 240 0% 9%), content at 92% lightness; an unselected row is drawn at 65% opacity.
it("the grey role text is 4.5:1 or better on glass, even on a dimmed row", async () => {
  const { contrast, hslToRgb } = await import("../../features/settings/model/themeSchemes");
  const bg = hslToRgb(240, 0, 9);
  const fg = hslToRgb(240, 0, 92);
  const at = (alpha: number) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as [number, number, number];
  expect(contrast(at(0.8 * 0.65), bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(at(0.8), bg)).toBeGreaterThanOrEqual(4.5);
});
