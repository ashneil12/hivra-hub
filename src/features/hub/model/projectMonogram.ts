// A project with no icon of its own gets two letters from its name on a coloured tile, and the same name always gets the
// same colour. T3 Code's projectMonogram and projectColor (apps/web/src/projectIdentity.ts, MIT, Copyright (c) 2026 T3
// Tools Inc.) are the originals; this is a line-for-line translation of the letters and the colour. One difference: a
// one-letter name stays one letter (T3 draws "XX" for "X").

/** The colours a monogram can wear. Names, not shades: the tile takes its colour from the theme token below. */
export const PROJECT_MONOGRAM_COLORS = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
  "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;

export type ProjectMonogramColor = (typeof PROJECT_MONOGRAM_COLORS)[number];

/**
 * Tailwind classes for each colour, at the strength a small tile needs: a tinted square and ink of the same hue. Bright
 * enough to tell two projects apart at 11 px, quiet enough to sit beside the grey shapes.
 */
export const MONOGRAM_CLASSES: Record<ProjectMonogramColor, string> = {
  gray: "bg-content/10 text-content/80",
  red: "bg-red-500/15 text-red-500",
  orange: "bg-orange-500/15 text-orange-500",
  amber: "bg-amber-500/15 text-amber-500",
  yellow: "bg-yellow-500/15 text-yellow-500",
  lime: "bg-lime-500/15 text-lime-500",
  green: "bg-green-500/15 text-green-500",
  emerald: "bg-emerald-500/15 text-emerald-500",
  teal: "bg-teal-500/15 text-teal-500",
  cyan: "bg-cyan-500/15 text-cyan-500",
  sky: "bg-sky-500/15 text-sky-500",
  blue: "bg-blue-500/15 text-blue-500",
  indigo: "bg-indigo-500/15 text-indigo-500",
  violet: "bg-violet-500/15 text-violet-500",
  purple: "bg-purple-500/15 text-purple-500",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-500",
  pink: "bg-pink-500/15 text-pink-500",
  rose: "bg-rose-500/15 text-rose-500",
};

/** The name as a person typed it, with compatibility forms folded (full-width letters, ligatures). */
function normalise(name: string): string {
  return name.normalize("NFKC").trim();
}

/** The name's words: letters and digits only, so punctuation, stray spacing and bare emoji are not words. */
function wordsOf(name: string): string[] {
  return normalise(name).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Two letters for a project's tile: the first letter and, when there is one, the digit inside the first word (so "M7
 * Forge" keeps its number), else the first letter of the last word ("Silver Orchard" -> SO), else the last letter of a
 * one-word name ("Nebula" -> NA). A name with nothing to draw from is "PR".
 */
export function projectMonogram(name: string): string {
  const words = wordsOf(name);
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  if (words.length === 1 && glyphs.length === 1) return first.toUpperCase();
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words[words.length - 1] ?? "")[0] : glyphs[glyphs.length - 1]) ??
    first;
  return `${first}${second}`.toUpperCase();
}

/** A colour for a name: the same name always picks the same one, whatever the case or spacing. */
export function projectMonogramColor(name: string): ProjectMonogramColor {
  const seed = normalise(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_MONOGRAM_COLORS.length;
  }
  return PROJECT_MONOGRAM_COLORS[index] ?? "blue";
}

/** The tile's classes for a name. */
export function projectMonogramClasses(name: string): string {
  return MONOGRAM_CLASSES[projectMonogramColor(name)];
}
