// First-launch onboarding state and theme presets (shared with Settings).
import {
  applySidebarOpacity,
  applyThemeDarkLightness,
  applyThemeTint,
  saveSidebarOpacity,
  saveThemeDarkLightness,
  saveThemeHue,
  saveThemeSaturation,
} from "../../settings/model/appearance";
import { setStripBackdrop } from "./stripBackdrop";
import { listMonos } from "../../monos/model/mono";
import { hubData } from "./hubData";

const KEY = "monocode:hub-onboarded";

/**
 * A first launch: nothing says the welcome was finished, and nothing is here yet. The finished mark lives in the
 * webview's storage, which can be cleared apart from the app's data, so an install that already has a first mate (the
 * roster comes back from the Monos' home on disk) or a project (the app's database) is never greeted as new: the mark
 * is written back instead.
 */
export function needsOnboarding(): boolean {
  if (new URLSearchParams(window.location.search).has("onboarding")) return true;
  try {
    if (localStorage.getItem(KEY) === "1") return false;
  } catch {
    return false;
  }
  if (alreadySetUp()) {
    finishOnboarding();
    return false;
  }
  return true;
}

function alreadySetUp(): boolean {
  try {
    if (listMonos().length > 0) return true;
  } catch {
    /* the roster is not readable: decide on the projects alone */
  }
  try {
    return hubData().listProjects().length > 0;
  } catch {
    /* the store is not up yet: nothing known, so this is a first launch */
    return false;
  }
}
export function finishOnboarding(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* best effort */
  }
}

export type ThemePresetId = "monocode" | "strip";
export const THEME_PRESETS: { id: ThemePresetId; label: string; blurb: string; hue: number; saturation: number; lightness: number; opacity: number }[] = [
  { id: "monocode", label: "Monocode", blurb: "Neutral and dark, the default.", hue: 240, saturation: 0, lightness: 9, opacity: 0.85 },
  { id: "strip", label: "Strip", blurb: "A warm tint over the same glass.", hue: 11, saturation: 20, lightness: 9, opacity: 0.85 },
];

/** Same values as Settings → Appearance → Presets. Glass stays on in both. */
export function applyThemePreset(id: ThemePresetId): void {
  const p = THEME_PRESETS.find((x) => x.id === id)!;
  const tint = applyThemeTint(p.hue, p.saturation);
  saveThemeHue(tint.hue);
  saveThemeSaturation(tint.saturation);
  saveThemeDarkLightness(applyThemeDarkLightness(p.lightness));
  saveSidebarOpacity(applySidebarOpacity(p.opacity));
  setStripBackdrop(id === "strip");
}
