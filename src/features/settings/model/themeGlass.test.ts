// @vitest-environment happy-dom
// F2 (r55): every theme Monocode ships is glass. A theme tints the tokens under Monocode's blur and never paints a
// solid window, and each scheme carries a light theme plus two dark ones, so changing scheme never leaves Ash without
// glass. The shipped default is the original monochrome Glass look.
import { expect, it } from "vitest";
import { MAX_THEME_OPACITY } from "./themeImport";
import { BUILT_IN_SCHEMES, DEFAULT_SCHEME_ID, themesOf } from "./themeSchemes";

/** A theme tints; too faint a tint stops reading as a window at all. */
const MIN_THEME_OPACITY = 0.15;
/** A dark theme's lightness stays under the range the theme file check allows. */
const MAX_DARK_LIGHTNESS = 20;

const isLight = (theme: { scheme?: "dark" | "light" }) => theme.scheme === "light";

it("the default is the original monochrome Glass look, tinted over the app's glass", () => {
  const scheme = BUILT_IN_SCHEMES.find((s) => s.id === DEFAULT_SCHEME_ID)!;
  const theme = themesOf(scheme)[0];
  expect(theme.id).toBe("glass");
  expect(scheme.saturation).toBe(0);
  expect(scheme.accent).toBeNull();
  expect(theme.opacity).toBeGreaterThan(MIN_THEME_OPACITY);
  expect(theme.opacity).toBeLessThanOrEqual(MAX_THEME_OPACITY);
});

it.each(BUILT_IN_SCHEMES.map((scheme) => [scheme.name, scheme] as const))(
  "%s: every theme keeps glass",
  (_, scheme) => {
    for (const theme of themesOf(scheme)) {
      expect(theme.opacity, `${scheme.name} / ${theme.name}`).toBeGreaterThanOrEqual(MIN_THEME_OPACITY);
      expect(theme.opacity, `${scheme.name} / ${theme.name}`).toBeLessThanOrEqual(MAX_THEME_OPACITY);
      if (!isLight(theme)) {
        expect(theme.lightness, `${scheme.name} / ${theme.name}`).toBeLessThanOrEqual(MAX_DARK_LIGHTNESS);
      }
    }
  },
);

it.each(BUILT_IN_SCHEMES.map((scheme) => [scheme.name, scheme] as const))(
  "%s: a light theme and two dark themes",
  (_, scheme) => {
    const themes = themesOf(scheme);
    expect(themes.filter(isLight), `${scheme.name} light`).toHaveLength(1);
    expect(themes.filter((theme) => !isLight(theme)), `${scheme.name} dark`).toHaveLength(2);
  },
);
