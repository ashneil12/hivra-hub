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
};

export const BUILT_IN_SCHEMES: readonly ThemeScheme[] = [
  { id: "glass", name: "Glass", hue: 240, saturation: 0, lightness: 9, opacity: 0.85, accent: null },
  { id: "graphite", name: "Graphite", hue: 220, saturation: 6, lightness: 5, opacity: 0.94, accent: null },
  { id: "dusk", name: "Dusk", hue: 258, saturation: 30, lightness: 11, opacity: 0.8, accent: "hsl(258 85% 72%)" },
];
export const DEFAULT_SCHEME_ID = "glass";

const ACTIVE_KEY = "monocode.themeScheme";
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
  applySchemeAccent(scheme?.accent ?? null);
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
