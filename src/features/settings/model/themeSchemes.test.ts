// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { BUILT_IN_SCHEMES, DEFAULT_SCHEME_ID, accentStatusDistance, schemeTextContrast, allSchemes, applySchemeAccent, loadActiveSchemeId, saveCustomScheme } from "./themeSchemes";

beforeEach(() => localStorage.clear());

it("ships three schemes: two monochrome, one colourful; the default is monochrome glass", () => {
  expect(BUILT_IN_SCHEMES).toHaveLength(3);
  expect(BUILT_IN_SCHEMES.filter((s) => s.accent === null)).toHaveLength(2);
  expect(loadActiveSchemeId()).toBe(DEFAULT_SCHEME_ID);
  const d = BUILT_IN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)!;
  expect(d.saturation).toBe(0);
  expect(d.accent).toBeNull();
});

it("a scheme made by Ash or a Mono can carry real colour, and is listed", () => {
  saveCustomScheme({ name: "Sunset", hue: 20, saturation: 40, lightness: 10, opacity: 0.8, accent: "#ff7a45" });
  expect(allSchemes().map((s) => s.name)).toContain("Sunset");
});

it("a scheme only sets a token", () => {
  applySchemeAccent("#ff7a45");
  expect(document.documentElement.style.getPropertyValue("--scheme-accent")).toBe("#ff7a45");
  applySchemeAccent(null);
  expect(document.documentElement.style.getPropertyValue("--scheme-accent")).toBe("");
});

it.each(BUILT_IN_SCHEMES.map((s) => [s.name, s] as const))("%s: small text ≥ 4.5:1 and status colours stay apart from the accent", (_, s) => {
  const c = schemeTextContrast(s);
  expect(c.body).toBeGreaterThanOrEqual(4.5);
  expect(c.small).toBeGreaterThanOrEqual(4.5);
  expect(accentStatusDistance(s.accent)).toBeGreaterThanOrEqual(40);
});
it("prints the contrast table", () => {
  for (const s of BUILT_IN_SCHEMES) {
    const c = schemeTextContrast(s);
    console.log(`CONTRAST ${s.name}: body ${c.body.toFixed(2)}:1, small ${c.small.toFixed(2)}:1, accent↔status ${accentStatusDistance(s.accent)}°`);
  }
});
