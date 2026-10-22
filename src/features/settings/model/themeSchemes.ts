/**
 * Named theme schemes. A scheme only overrides theme tokens (hue, saturation, dark lightness, sidebar opacity, and an
 * optional scheme accent), so every screen that draws with tokens restyles with no edits of its own. The shipped
 * default ("Glass") is monochrome. A scheme may carry real colour; whether to limit that is Ash's call, not code's.
 */
export type ThemeScheme = {
  id: string;
  name: string;
  hue: number;
  saturation: number;
  lightness: number;
  /** Sidebar opacity, 0.15–1. */
  opacity: number;
  /** Accent colour for this scheme (any CSS colour), or null for monochrome. */
  accent: string | null;
  /** Made by Ash or a Mono, not shipped. */
  custom?: boolean;
  /** Which colour scheme it is for (a theme file says); absent means dark. */
  scheme?: "dark" | "light";
  /**
   * F3: a scheme holds several themes, each the same tokens under its own name. The scheme's own fields are its first
   * theme; without `themes` the scheme is simply its one theme. Shipped schemes carry a few; a Mono's file can carry up
   * to seven.
   */
  themes?: SchemeTheme[];
  /** The Mono that made it (a theme file it wrote), by name. */
  by?: string;
};

/** One theme inside a scheme: the same tokens as a scheme, with its own name and dark/light mode. */
export type SchemeTheme = Pick<ThemeScheme, "hue" | "saturation" | "lightness" | "opacity" | "accent"> & {
  id: string;
  name: string;
  /** This theme is for the light colour scheme (absent means dark). */
  scheme?: "dark" | "light";
};

/** A scheme's themes: its own list, or the scheme itself as its one theme. */
export function themesOf(scheme: ThemeScheme): SchemeTheme[] {
  if (scheme.themes?.length) return scheme.themes;
  const { id, name, hue, saturation, lightness, opacity, accent, scheme: mode } = scheme;
  return [{ id, name, hue, saturation, lightness, opacity, accent, ...(mode ? { scheme: mode } : {}) }];
}

/** The theme a scheme is showing: the one Ash picked, or its first. */
export function activeThemeOf(scheme: ThemeScheme): SchemeTheme {
  const themes = themesOf(scheme);
  const wanted = loadActiveThemeId();
  return themes.find((t) => t.id === wanted) ?? themes[0];
}

export const BUILT_IN_SCHEMES: readonly ThemeScheme[] = [
  {
    id: "glass",
    name: "Glass",
    hue: 240,
    saturation: 0,
    lightness: 9,
    opacity: 0.85,
    accent: null,
    themes: [
      { id: "glass", name: "Glass", hue: 240, saturation: 0, lightness: 9, opacity: 0.85, accent: null },
      { id: "midnight", name: "Midnight", hue: 240, saturation: 35, lightness: 6, opacity: 0.9, accent: "hsl(240 80% 72%)" },
      { id: "frost", name: "Frost", hue: 240, saturation: 0, lightness: 96, opacity: 0.9, accent: null, scheme: "light" },
    ],
  },
  {
    id: "graphite",
    name: "Graphite",
    hue: 220,
    saturation: 6,
    lightness: 5,
    opacity: 0.94,
    accent: null,
    themes: [
      { id: "graphite", name: "Graphite", hue: 220, saturation: 6, lightness: 5, opacity: 0.94, accent: null },
      { id: "ink", name: "Ink", hue: 220, saturation: 10, lightness: 3, opacity: 0.9, accent: null },
      { id: "paper", name: "Paper", hue: 220, saturation: 8, lightness: 97, opacity: 0.92, accent: null, scheme: "light" },
    ],
  },
  {
    id: "dusk",
    name: "Dusk",
    hue: 258,
    saturation: 30,
    lightness: 11,
    opacity: 0.8,
    accent: "hsl(258 85% 72%)",
    themes: [
      { id: "dusk", name: "Dusk", hue: 258, saturation: 30, lightness: 11, opacity: 0.8, accent: "hsl(258 85% 72%)" },
      { id: "twilight", name: "Twilight", hue: 258, saturation: 45, lightness: 7, opacity: 0.88, accent: "hsl(258 90% 76%)" },
      { id: "daylight", name: "Daylight", hue: 258, saturation: 30, lightness: 96, opacity: 0.9, accent: "hsl(258 60% 45%)", scheme: "light" },
    ],
  },
];
export const DEFAULT_SCHEME_ID = "glass";

const ACTIVE_KEY = "monocode.themeScheme";
const ACTIVE_THEME_KEY = "monocode.themeSchemeTheme";
const CUSTOM_KEY = "monocode.themeSchemesCustom";

export function loadCustomSchemes(): ThemeScheme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]") as ThemeScheme[];
    return raw.filter((s) => s && typeof s.id === "string" && typeof s.name === "string").map((s) => ({ ...s, custom: true }));
  } catch {
    return [];
  }
}
export function allSchemes(): ThemeScheme[] {
  return [...BUILT_IN_SCHEMES, ...loadCustomSchemes()];
}
export function loadActiveSchemeId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? DEFAULT_SCHEME_ID;
  } catch {
    return DEFAULT_SCHEME_ID;
  }
}
export function saveActiveSchemeId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* best effort */
  }
}
/** Which theme of the active scheme is on (absent: its first). */
export function loadActiveThemeId(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_THEME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveActiveThemeId(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(ACTIVE_THEME_KEY, id);
    else localStorage.removeItem(ACTIVE_THEME_KEY);
  } catch {
    /* best effort */
  }
}
/** Save a named scheme made by Ash or a Mono. Same name replaces it. */
export function saveCustomScheme(scheme: Omit<ThemeScheme, "id" | "custom"> & { id?: string }): ThemeScheme {
  const id = scheme.id ?? `custom-${scheme.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const next: ThemeScheme = { ...scheme, id, custom: true };
  const list = [...loadCustomSchemes().filter((s) => s.id !== id), next];
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return next;
}

/** Take a theme Ash or a Mono added off the list. Built-in schemes stay. */
export function removeCustomScheme(id: string): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(loadCustomSchemes().filter((s) => s.id !== id)));
  } catch {
    /* best effort */
  }
}

/** The scheme-only token: its accent. Everything else goes through the existing Appearance setters. */
export function applySchemeAccent(accent: string | null, root: HTMLElement = document.documentElement): void {
  if (accent) root.style.setProperty("--scheme-accent", accent);
  else root.style.removeProperty("--scheme-accent");
}
/** At launch: put the active scheme's accent token back (hue and the rest are restored by the boot script). */
export function restoreSchemeAccent(): void {
  const scheme = allSchemes().find((s) => s.id === loadActiveSchemeId());
  applySchemeAccent(scheme ? activeThemeOf(scheme).accent : null);
}

// ---- checks every scheme must pass (tested in themeSchemes.test.ts) -------------------------------------------------
type Rgb = [number, number, number];
export function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function luminance([r, g, b]: Rgb): number {
  const c = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const mix = (top: Rgb, under: Rgb, alpha: number): Rgb => top.map((v, i) => v * alpha + under[i] * (1 - alpha)) as Rgb;
/** The faintest small text Pages uses: content at 60% (text-content/60). */
export const SMALL_TEXT_ALPHA = 0.6;
/** Dark theme only: content 92% lightness; small text sits on a raised surface (content at 8% over the background). */
export function schemeTextContrast(s: Pick<ThemeScheme, "hue" | "saturation" | "lightness">): { body: number; small: number } {
  const bg = hslToRgb(s.hue, s.saturation, s.lightness);
  const content = hslToRgb(s.hue, s.saturation, 92);
  const surface = mix(content, bg, 0.08);
  return { body: contrast(content, bg), small: contrast(mix(content, surface, SMALL_TEXT_ALPHA), surface) };
}
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbHue([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
/** The status colours (the defaults of --color-status-*). */
export const STATUS_COLOURS = { ok: "#34d399", warn: "#fbbf24", bad: "#f87171" } as const;
/** Hue of a scheme accent written as hsl(H …) or #rrggbb; NaN for monochrome. */
export function accentHue(accent: string | null): number {
  if (!accent) return NaN;
  const m = accent.match(/^hsl\(\s*([\d.]+)/);
  return m ? Number(m[1]) : rgbHue(hexToRgb(accent));
}
/** Smallest hue distance between the scheme accent and any status colour (Infinity when monochrome). */
export function accentStatusDistance(accent: string | null): number {
  const h = accentHue(accent);
  if (Number.isNaN(h)) return Infinity;
  return Math.min(...Object.values(STATUS_COLOURS).map((c) => {
    const d = Math.abs(rgbHue(hexToRgb(c)) - h) % 360;
    return Math.min(d, 360 - d);
  }));
}
