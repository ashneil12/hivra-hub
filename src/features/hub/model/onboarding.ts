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
import { IS_HUB_BUNDLE } from "./hubBundle";

const KEY = "monocode:hub-onboarded";

export function needsOnboarding(): boolean {
  if (new URLSearchParams(window.location.search).has("onboarding")) return true;
  // The MonoCode Hub bundle (VITE_MONOCODE_HUB=1, see src-tauri/tauri.hub.conf.json) opens straight on the hub: Ash's
  // projects come from Ash OS, so there is no setup file to restore and no first project to make.
  if (IS_HUB_BUNDLE) return false;
  try {
    return localStorage.getItem(KEY) !== "1";
  } catch {
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
