/**
 * F3: themes as JSON. Ash or a Mono hands one in; it is checked on the way in (shape, ranges, text contrast, an accent
 * that can't be mistaken for a status colour, at most 7 per colour scheme). A checked theme can be previewed (the app
 * restyles, nothing is saved), applied (saved and made active) or discarded. One a Mono hands in leaves a Bot changes
 * row whose Undo puts the look back the way it was.
 */
import { useSyncExternalStore } from "react";
import {
  applySidebarOpacity,
  applyThemeDarkLightness,
  applyThemeTint,
  loadSidebarOpacity,
  loadThemeDarkLightness,
  loadThemeHue,
  loadThemeSaturation,
  saveSidebarOpacity,
  saveThemeDarkLightness,
  saveThemeHue,
  saveThemeSaturation,
} from "./appearance";
import {
  accentStatusDistance,
  allSchemes,
  applySchemeAccent,
  loadActiveSchemeId,
  loadCustomSchemes,
  saveActiveSchemeId,
  saveCustomScheme,
  schemeTextContrast,
  type ThemeScheme,
} from "./themeSchemes";
import { recordThemeChange, type ThemeLook } from "../../hub/model/botChanges";
import { registerChangeKind } from "../../selfBuild/model/changeFlow";
import { loadMonoFiles, readAgentFile } from "../../monos/model/monoFiles";

export const MAX_THEMES_PER_SCHEME = 7;
const UNREADABLE = "This isn't a theme file we can read.";
/** Themes tint over Monocode glass (the default) and never go solid, so some of the glass always shows. */
export const MAX_THEME_OPACITY = 0.95;

export type ThemeCheck = { ok: true; theme: Omit<ThemeScheme, "id" | "custom"> & { id: string } } | { ok: false; problems: string[] };

const idOf = (name: string) => `custom-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** Check a theme file. Problems are plain sentences, every one found, so Ash can fix them all at once. */
export function checkThemeJson(text: string, existing: readonly ThemeScheme[] = loadCustomSchemes()): ThemeCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: [UNREADABLE] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: [UNREADABLE] };
  const t = raw as Record<string, unknown>;
  const problems: string[] = [];
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name || name.length > 40) problems.push("It needs a short name.");
  const scheme = t.scheme === undefined ? "dark" : t.scheme;
  if (scheme !== "dark" && scheme !== "light") problems.push("It doesn't say whether it's a dark or a light theme.");
  if (!num(t.hue, 0, 360)) problems.push("Its colour is missing or isn't one we can use.");
  if (!num(t.saturation, 0, 100)) problems.push("How strong its colour is is missing or isn't something we can use.");
  if (scheme === "dark" && !num(t.lightness, 0, 20))
    problems.push(num(t.lightness, 20, 100) ? "It's too bright for a dark theme." : "It doesn't say how dark it is.");
  if (scheme === "light" && t.lightness !== undefined && !num(t.lightness, 0, 100)) problems.push("Its brightness isn't something we can use.");
  if (!num(t.opacity, 0.15, MAX_THEME_OPACITY))
    problems.push("It would make the glass solid or almost invisible.");
  const accent = t.accent ?? null;
  if (accent !== null && (typeof accent !== "string" || !/^(#[0-9a-f]{6}|hsl\(\s*[\d.]+(deg)?[\s,]+[\d.]+%[\s,]+[\d.]+%\s*\))$/i.test(accent)))
    problems.push("Its accent colour is written in a way we can't read.");
  if (problems.length) return { ok: false, problems };
  const theme = {
    id: idOf(name),
    name,
    scheme: scheme as "dark" | "light",
    hue: t.hue as number,
    saturation: t.saturation as number,
    lightness: typeof t.lightness === "number" ? t.lightness : 96,
    opacity: t.opacity as number,
    accent: accent as string | null,
  };
  if (theme.scheme === "dark") {
    const c = schemeTextContrast(theme);
    if (c.body < 7) problems.push("Text would be hard to read on it.");
    else if (c.small < 4.5) problems.push("Small text would be hard to read on it.");
  }
  if (accentStatusDistance(theme.accent) < 20) problems.push("Its accent looks too much like the green, amber or red we use to show how things are going.");
  const sameScheme = existing.filter((s) => (s.scheme ?? "dark") === theme.scheme && s.id !== theme.id);
  if (sameScheme.length >= MAX_THEMES_PER_SCHEME)
    problems.push(`You already have as many ${theme.scheme} themes as we keep. Remove one first.`);
  return problems.length ? { ok: false, problems } : { ok: true, theme };
}

/** How the app looks right now, as Undo and Discard put it back. */
export function currentLook(): ThemeLook {
  const schemeId = loadActiveSchemeId();
  return {
    schemeId,
    hue: loadThemeHue(),
    saturation: loadThemeSaturation(),
    lightness: loadThemeDarkLightness(),
    opacity: loadSidebarOpacity(),
    accent: allSchemes().find((s) => s.id === schemeId)?.accent ?? null,
  };
}
const lookOf = (t: Omit<ThemeScheme, "custom">): ThemeLook => ({
  schemeId: t.id,
  hue: t.hue,
  saturation: t.saturation,
  lightness: t.scheme === "light" ? loadThemeDarkLightness() : t.lightness,
  opacity: t.opacity,
  accent: t.accent,
});
function show(look: ThemeLook): void {
  applyThemeTint(look.hue, look.saturation);
  applyThemeDarkLightness(look.lightness);
  applySidebarOpacity(look.opacity);
  applySchemeAccent(look.accent);
}
/** Show a look and keep it. */
export function putLook(look: ThemeLook): void {
  show(look);
  saveThemeHue(look.hue);
  saveThemeSaturation(look.saturation);
  saveThemeDarkLightness(look.lightness);
  saveSidebarOpacity(look.opacity);
  saveActiveSchemeId(look.schemeId);
  emit();
}

/** A theme handed in and waiting on Ash: checked, maybe being previewed. */
export type PendingTheme = { check: ThemeCheck; by?: string; previewing: boolean };
let pending: PendingTheme | undefined;
/** How it looked before the preview started, so Stop preview and Discard can put it back. */
let beforePreview: ThemeLook | undefined;
let version = 0;
const subs = new Set<() => void>();
function emit(): void {
  version++;
  subs.forEach((f) => f());
}
export function useThemeImportVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}
export const pendingTheme = (): PendingTheme | undefined => pending;
/** The look being previewed, for the sliders to show (PM-21); undefined when nothing is. */
export const previewLook = (): ThemeLook | undefined => (pending?.previewing && pending.check.ok ? lookOf(pending.check.theme) : undefined);
/** Whether the app is showing a theme that isn't saved yet. */
export const previewingTheme = (): boolean => !!pending?.previewing;

/** Hand in a theme file (Ash pasting one, or a Mono by name). Replaces one already waiting. */
export function offerTheme(text: string, by?: string): ThemeCheck {
  if (pending?.previewing) stopPreview();
  const check = checkThemeJson(text);
  pending = { check, by, previewing: false };
  emit();
  return check;
}
export function previewTheme(): void {
  if (!pending?.check.ok || pending.previewing) return;
  beforePreview = currentLook();
  show(lookOf(pending.check.theme));
  pending = { ...pending, previewing: true };
  emit();
}
/** Back to how it looked; the theme stays waiting. */
export function stopPreview(): void {
  if (!pending?.previewing) return;
  if (beforePreview) show(beforePreview);
  beforePreview = undefined;
  pending = { ...pending, previewing: false };
  emit();
}
/** Throw the theme away; the look goes back if it was being previewed. */
export function discardTheme(): void {
  stopPreview();
  pending = undefined;
  emit();
}
/** Save the theme, make it the active one, and (from a Mono) leave a Bot changes row with Undo. */
export function applyTheme(): ThemeScheme | undefined {
  if (!pending?.check.ok) return undefined;
  const before = beforePreview ?? currentLook();
  const { by } = pending;
  const saved = saveCustomScheme(pending.check.theme);
  const after = lookOf(saved);
  putLook(after);
  beforePreview = undefined;
  pending = undefined;
  if (by) recordThemeChange(by, saved.name, before, after, allSchemes().find((x) => x.id === before.schemeId)?.name ?? "your last theme");
  emit();
  return saved;
}

/** The theme files a Mono keeps (`themes/<name>.json` in its folder), by name. */
export async function monoThemeNames(monoId: string): Promise<string[]> {
  return (await loadMonoFiles(monoId)).themes ?? [];
}
/** Hand in one of a Mono's theme files, checked the same way as a pasted one. */
export async function offerMonoTheme(monoId: string, name: string, by: string): Promise<ThemeCheck> {
  let text: string | null;
  try {
    text = (await readAgentFile(monoId, `themes/${name}.json`)).text;
  } catch {
    text = null;
  }
  if (text === null) {
    const check: ThemeCheck = { ok: false, problems: [`${by} has no theme called “${name}”.`] };
    if (pending?.previewing) stopPreview();
    pending = { check, by, previewing: false };
    emit();
    return check;
  }
  return offerTheme(text, by);
}

// A Mono's applied theme is a "theme" change (selfBuild/model/changeFlow.ts): its Bot changes row's Undo and Redo
// come here. Settings → Appearance is where a theme is previewed and applied, so there is no apply from elsewhere.
registerChangeKind("theme", {
  apply: async () => {
    throw new Error("A theme is previewed and applied in Settings → Appearance.");
  },
  undo: async (data) => {
    putLook((data as { before: ThemeLook }).before);
    return null;
  },
  redo: async (data) => putLook((data as { after: ThemeLook }).after),
});

// The dev page and proofs hand a theme in the way a Mono's tool would.
if (typeof window !== "undefined") (window as unknown as { __devOfferTheme?: typeof offerTheme }).__devOfferTheme = offerTheme;
