/**
 * F3: themes a Mono makes. A Mono writes a plain JSON theme file into its folder (`themes/<name>.json`) holding a
 * scheme with one to seven themes; Settings → Appearance finds it, checks it at the boundary and shows it as an offer
 * Ash can preview on the whole app, apply (a Bot changes row with Undo) or discard. Any of the roster's Monos may offer
 * one; a temporary worker, which is not in the roster, can't.
 *
 * The file, as a Mono writes it:
 *   { "scheme": "Harbour", "themes": [ { "name": "Harbour night", "hue": 210, "saturation": 22, "lightness": 9,
 *     "opacity": 0.82, "accent": "#6cb6ff" }, { "name": "Harbour light", "scheme": "light", "hue": 210,
 *     "saturation": 18, "lightness": 96, "opacity": 0.9, "accent": null } ] }
 *
 * A single theme in the older shape (`{ "name": "Night", "scheme": "dark", "hue": …, … }`) is taken as a scheme of
 * one theme, so an existing theme file keeps working.
 *
 * Every dark theme keeps the Monocode glass see-through (opacity 0.5 to 0.95, never solid) and keeps its text at 7:1
 * for body and 4.5:1 for small text, like the shipped schemes; an accent may not sit within 30° of the green, amber
 * or red that mean done, waiting or stuck.
 */
import { useSyncExternalStore } from "react";
import {
  applySidebarOpacity,
  applyThemeDarkLightness,
  applyThemePreference,
  applyThemeTint,
  isLightScheme,
  loadSidebarOpacity,
  loadThemeDarkLightness,
  loadThemeHue,
  loadThemeSaturation,
  saveSidebarOpacity,
  saveThemeDarkLightness,
  saveThemeHue,
  saveThemePreference,
  saveThemeSaturation,
} from "./appearance";
import {
  BUILT_IN_SCHEMES,
  accentStatusDistance,
  allSchemes,
  applySchemeAccent,
  loadActiveSchemeId,
  loadActiveThemeId,
  saveActiveSchemeId,
  saveActiveThemeId,
  saveCustomScheme,
  schemeTextContrast,
  themesOf,
  type SchemeTheme,
  type ThemeScheme,
} from "./themeSchemes";
import { recordThemeChange, type ThemeLook } from "../../hub/model/botChanges";
import { listMonos, monoLook } from "../../monos/model/mono";
import { loadMonoFiles, readAgentFile } from "../../monos/model/monoFiles";

export const MAX_THEMES_PER_FILE = 7;
/** A theme tints over the glass and never goes solid, nor so thin nothing reads. */
export const THEME_OPACITY_RANGE = [0.5, 0.95] as const;
/** An accent this close in hue to green, amber or red would read as a status colour. */
export const MIN_STATUS_DISTANCE = 30;
const WORKERS_CANT = "Only your Monos can make themes. A temporary worker can't.";
const UNREADABLE = "This isn't a theme file we can read.";

type Obj = Record<string, unknown>;
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const slug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** "#rgb", "#rrggbb" or "hsl(H S% L%)" (commas allowed): the accents a theme file may use. */
export function parseAccent(value: string): { hue: number; text: string } | undefined {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) return { hue: hexHue(hex[1]), text: v };
  const hsl = v.match(/^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i);
  if (hsl) {
    const [h, s, l] = hsl.slice(1).map(Number);
    if (h <= 360 && s <= 100 && l <= 100) return { hue: h, text: v };
  }
  return undefined;
}
function hexHue(raw: string): number {
  const h = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  const n = parseInt(h, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return NaN;
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (hue * 60 + 360) % 360;
}

export type ThemeFileCheck =
  | { ok: true; scheme: ThemeScheme }
  | { ok: false; problems: string[] };

/** One theme's tokens, or every problem with it in plain words. */
function checkTheme(raw: unknown, index: number): { theme?: SchemeTheme; problems: string[] } {
  const where = `Theme ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: [`${where} isn't a theme.`] };
  const x = raw as Obj;
  const problems: string[] = [];
  const name = typeof x.name === "string" ? x.name.trim() : "";
  if (!name || name.length > 40) problems.push(`${where} needs a name of up to 40 letters.`);
  const label = name ? `“${name}”` : where;
  const mode = x.scheme === undefined ? "dark" : x.scheme;
  if (mode !== "dark" && mode !== "light") problems.push(`${label} doesn't say whether it's a dark or a light theme.`);
  if (!num(x.hue, 0, 360)) problems.push(`${label}'s colour is missing or isn't one we can use.`);
  if (!num(x.saturation, 0, 100)) problems.push(`${label}'s colour strength is missing or isn't one we can use.`);
  if (mode === "dark" && !num(x.lightness, 0, 20))
    problems.push(num(x.lightness, 20, 100) ? `${label} is too bright for a dark theme.` : `${label} doesn't say how dark it is.`);
  if (mode === "light" && x.lightness !== undefined && !num(x.lightness, 80, 100))
    problems.push(`${label} is a light theme, so its brightness has to be near white.`);
  const opacity = x.opacity === undefined ? 0.85 : Number(x.opacity);
  if (!num(opacity, THEME_OPACITY_RANGE[0], THEME_OPACITY_RANGE[1])) problems.push(`${label} would make the glass solid or almost invisible.`);
  let accent: string | null = null;
  if (x.accent !== undefined && x.accent !== null) {
    if (typeof x.accent !== "string" || !parseAccent(x.accent)) problems.push(`${label}'s accent is written in a way we can't read.`);
    else accent = x.accent.trim();
  }
  if (problems.length) return { problems };
  const lightness = mode === "light" ? (typeof x.lightness === "number" ? x.lightness : 96) : Number(x.lightness);
  const theme: SchemeTheme = {
    id: slug(name) || `theme-${index + 1}`,
    name,
    ...(mode === "light" ? { scheme: "light" as const } : {}),
    hue: x.hue as number,
    saturation: x.saturation as number,
    lightness,
    opacity,
    accent,
  };
  if (mode === "dark") {
    const c = schemeTextContrast(theme);
    if (c.body < 7) problems.push(`${label}'s text would be hard to read on it.`);
    else if (c.small < 4.5) problems.push(`${label}'s small text would be hard to read on it.`);
  }
  if (accent && accentStatusDistance(accent) < MIN_STATUS_DISTANCE)
    problems.push(`${label}'s accent looks too much like the green, amber or red we use to show how things are going.`);
  return problems.length ? { problems } : { theme, problems: [] };
}

/**
 * Check a theme file at the boundary. Problems are plain sentences, every one found. Accepts the multi-theme shape
 * (`scheme` plus `themes`) and the older single-theme shape.
 */
export function checkThemeFile(text: string): ThemeFileCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: [UNREADABLE] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problems: [UNREADABLE] };
  const x = raw as Obj;
  const single = !Array.isArray(x.themes);
  if (single) {
    const one = checkTheme(x, 0);
    if (!one.theme) return { ok: false, problems: one.problems };
    const theme = one.theme;
    return { ok: true, scheme: { id: `custom-${theme.id}`, name: theme.name, hue: theme.hue, saturation: theme.saturation, lightness: theme.lightness, opacity: theme.opacity, accent: theme.accent, ...(theme.scheme ? { scheme: theme.scheme } : {}), custom: true, themes: [theme] } };
  }
  const name = typeof x.scheme === "string" ? x.scheme.trim() : "";
  const problems: string[] = [];
  if (!name || name.length > 40) problems.push("The scheme needs a name of up to 40 letters.");
  if (name && BUILT_IN_SCHEMES.some((s) => s.name.toLowerCase() === name.toLowerCase())) problems.push(`“${name}” is a shipped scheme's name. Pick another.`);
  const list = x.themes as unknown[];
  if (list.length < 1 || list.length > MAX_THEMES_PER_FILE) problems.push(`A scheme holds 1 to ${MAX_THEMES_PER_FILE} themes.`);
  const themes: SchemeTheme[] = [];
  for (const [i, t] of list.slice(0, MAX_THEMES_PER_FILE).entries()) {
    const one = checkTheme(t, i);
    problems.push(...one.problems);
    if (!one.theme) continue;
    if (themes.some((o) => o.id === one.theme!.id)) problems.push(`Two themes are called “${one.theme.name}”.`);
    else themes.push(one.theme);
  }
  if (problems.length || !name) return { ok: false, problems };
  const first = themes[0];
  return {
    ok: true,
    scheme: {
      id: `custom-${slug(name)}`,
      name,
      hue: first.hue,
      saturation: first.saturation,
      lightness: first.lightness,
      opacity: first.opacity,
      accent: first.accent,
      ...(first.scheme ? { scheme: first.scheme } : {}),
      custom: true,
      themes,
    },
  };
}

// ---- the look on screen ---------------------------------------------------------------------------------------------
/** How the app looks right now, as Undo and a lost preview put it back. */
export function currentLook(): ThemeLook {
  const schemeId = loadActiveSchemeId();
  const scheme = allSchemes().find((s) => s.id === schemeId);
  const theme = scheme ? themesOf(scheme).find((t) => t.id === loadActiveThemeId()) ?? themesOf(scheme)[0] : undefined;
  return {
    schemeId,
    themeId: theme?.id,
    mode: isLightScheme() ? "light" : "dark",
    hue: loadThemeHue(),
    saturation: loadThemeSaturation(),
    lightness: loadThemeDarkLightness(),
    opacity: loadSidebarOpacity(),
    accent: theme?.accent ?? null,
  };
}
function lookOf(scheme: ThemeScheme, theme: SchemeTheme): ThemeLook {
  return {
    schemeId: scheme.id,
    themeId: theme.id,
    mode: theme.scheme ?? "dark",
    hue: theme.hue,
    saturation: theme.saturation,
    // A light theme keeps the dark-mode lightness Ash already chose, for when dark mode comes back.
    lightness: theme.scheme === "light" ? loadThemeDarkLightness() : theme.lightness,
    opacity: theme.opacity,
    accent: theme.accent,
  };
}
function paint(look: ThemeLook): void {
  applyThemeTint(look.hue, look.saturation);
  applyThemeDarkLightness(look.lightness);
  applySidebarOpacity(look.opacity);
  applySchemeAccent(look.accent);
  if (look.mode) {
    saveThemePreference(look.mode);
    applyThemePreference(look.mode);
  }
  changed();
}
function keep(look: ThemeLook): void {
  saveThemeHue(look.hue);
  saveThemeSaturation(look.saturation);
  saveThemeDarkLightness(look.lightness);
  saveSidebarOpacity(look.opacity);
  saveActiveSchemeId(look.schemeId);
  saveActiveThemeId(look.themeId);
  paint(look);
}

/** Ash picks a theme in Settings: it goes on and is kept. Its scheme goes on too. */
export function pickTheme(scheme: ThemeScheme, theme: SchemeTheme = themesOf(scheme)[0]): void {
  keep(lookOf(scheme, theme));
}
/** The scheme and theme the app is showing, for the picker to mark. */
export function activeThemeChoice(): { schemeId: string; themeId?: string } {
  return { schemeId: loadActiveSchemeId(), themeId: loadActiveThemeId() };
}

// ---- offers from Monos ----------------------------------------------------------------------------------------------
export type ThemeOffer = { id: string; monoId: string; by: string; file: string; scheme: ThemeScheme; signature: string };
export type ThemeRefusal = { id: string; by: string; file: string; reason: string };
let offers: ThemeOffer[] = [];
let refusals: ThemeRefusal[] = [];
let previewing: { offerId: string; themeId: string; before: ThemeLook } | undefined;
let version = 0;
const subs = new Set<() => void>();
function changed(): void {
  version++;
  subs.forEach((f) => f());
}
export function useThemesVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
}
export const themeOffers = (): readonly ThemeOffer[] => offers;
export const themeRefusals = (): readonly ThemeRefusal[] => refusals;
export const themePreview = (): { offerId: string; themeId: string } | undefined =>
  previewing && { offerId: previewing.offerId, themeId: previewing.themeId };

/**
 * Files Ash has already applied or discarded, by signature (the file's contents, so a Mono editing it offers it
 * again). Kept so opening Appearance doesn't ask the same question twice.
 */
const HANDLED_KEY = "monocode.themeFilesHandled";
function loadHandled(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "{}") as Record<string, string>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function markHandled(id: string, signature: string): void {
  try {
    localStorage.setItem(HANDLED_KEY, JSON.stringify({ ...loadHandled(), [id]: signature }));
  } catch {
    /* best effort */
  }
}
function signatureOf(monoId: string, file: string, text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${monoId}:${file}:${h.toString(36)}:${text.length}`;
}
const nameOf = (monoId: string): string => {
  const mono = listMonos().find((m) => m.id === monoId);
  return mono ? monoLook(mono).name : monoId;
};

/**
 * A Mono wrote a theme file: skipped when Ash already answered this exact file, refused in plain words when it can't
 * be used, else offered. Returns the reason when it was refused.
 */
export function offerThemeFile(monoId: string, file: string, text: string): string | undefined {
  const by = nameOf(monoId);
  const id = `${monoId}:${file}`;
  const signature = signatureOf(monoId, file, text);
  if (loadHandled()[id] === signature) return undefined;
  offers = offers.filter((o) => o.id !== id);
  refusals = refusals.filter((r) => r.id !== id);
  const seated = listMonos().some((m) => m.id === monoId);
  const reason = !seated
    ? WORKERS_CANT
    : (() => {
        const checked = checkThemeFile(text);
        if (!checked.ok) return checked.problems.join(" ");
        offers = [...offers, { id, monoId, by, file, scheme: { ...checked.scheme, by }, signature }];
        return undefined;
      })();
  if (reason) refusals = [...refusals, { id, by, file, reason }];
  changed();
  return reason;
}

/** Show one of an offer's themes on the whole app, without keeping it. */
export function previewOffer(offerId: string, themeId?: string): void {
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) return;
  const theme = themesOf(offer.scheme).find((t) => t.id === themeId) ?? themesOf(offer.scheme)[0];
  previewing = { offerId, themeId: theme.id, before: previewing?.before ?? currentLook() };
  paint(lookOf(offer.scheme, theme));
}
/** The look an offered theme is previewing, for the sliders (undefined when nothing is). */
export function offeredPreviewLook(): ThemeLook | undefined {
  if (!previewing) return undefined;
  const offer = offers.find((o) => o.id === previewing!.offerId);
  const theme = offer && themesOf(offer.scheme).find((t) => t.id === previewing!.themeId);
  return offer && theme ? lookOf(offer.scheme, theme) : undefined;
}
/** Back to what was on before the preview. */
export function endPreview(): void {
  if (!previewing) return;
  const before = previewing.before;
  previewing = undefined;
  paint(before);
}

/** Keep an offer (the previewed theme, else its first): it joins the schemes, goes on, and Bot changes gets an Undo. */
export function applyOffer(offerId: string, themeId?: string): void {
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) return;
  const before = previewing?.before ?? currentLook();
  const chosen = themeId ?? (previewing?.offerId === offerId ? previewing.themeId : undefined);
  previewing = undefined;
  const replaced = allSchemes().some((s) => s.id === offer.scheme.id);
  const saved = saveCustomScheme(offer.scheme);
  const theme = themesOf(saved).find((t) => t.id === chosen) ?? themesOf(saved)[0];
  const after = lookOf(saved, theme);
  keep(after);
  offers = offers.filter((o) => o.id !== offerId);
  refusals = refusals.filter((r) => r.id !== offerId);
  markHandled(offer.id, offer.signature);
  const beforeName = allSchemes().find((x) => x.id === before.schemeId)?.name ?? "your last theme";
  recordThemeChange(offer.by, theme.name, before, after, beforeName, replaced ? undefined : saved);
  changed();
}
export function discardOffer(offerId: string): void {
  const offer = offers.find((o) => o.id === offerId);
  if (previewing?.offerId === offerId) endPreview();
  offers = offers.filter((o) => o.id !== offerId);
  refusals = refusals.filter((r) => r.id !== offerId);
  if (offer) markHandled(offer.id, offer.signature);
  changed();
}

/** Read every Mono's `themes/<name>.json` and offer what it hasn't asked about yet. Returns how many it read. */
let scanning: Promise<number> | undefined;
export function scanMonoThemes(): Promise<number> {
  if (scanning) return scanning;
  scanning = (async () => {
    let read = 0;
    for (const mono of listMonos()) {
      let names: string[];
      try {
        names = (await loadMonoFiles(mono.id)).themes ?? [];
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const file = await readAgentFile(mono.id, `themes/${name}.json`);
          if (!file.text) continue;
          read++;
          offerThemeFile(mono.id, `themes/${name}.json`, file.text);
        } catch {
          // A file that can't be read offers nothing; the rest still do.
        }
      }
    }
    return read;
  })().finally(() => (scanning = undefined));
  return scanning;
}

/** Tests only: forget offers, refusals and any preview. */
export function resetThemeOffersForTests(): void {
  offers = [];
  refusals = [];
  previewing = undefined;
  changed();
}
