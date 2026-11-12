// F2 (r55): every surface that floats over the app is glass. A menu, dialog, sheet or toast added by hand carries
// .popover-glass / .dialog-glass / .solid-panel-glass, or puts a <GlassBackdrop> inside itself, the way every Popover
// and Modal already does. A fill of its own would be a fixed colour that ignores whatever theme Ash is on. Native
// macOS menus belong to the system and are not in this source.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

const FILES = sources(SRC).map((path) => relative(SRC, path)).sort();
const lines = (file: string) => readFileSync(join(SRC, file), "utf8").split("\n");

const FLOATING = /\b(?:absolute|fixed)\b/;
/** A background the theme's glass cannot show through: a fixed colour, or a token painted at full strength. */
const OPAQUE = /(?<![\w:-])bg-(?:\[(?:#|rgb|hsl)|background-base|surface|content|white|black)(?![\w/-])/;
const SHADOW = /\bshadow-(?:md|lg|xl|2xl)\b/;
const GLASS = /\b(?:popover-glass|dialog-glass|solid-panel-glass|sidebar-glass|glass-bar|popover-backdrop|backdrop-blur)\b/;

/**
 * Opaque fills that are not a surface floating over content: a switch thumb has to read on any track, a count badge
 * clears the icon under it, and a progress bar or drag handle is a mark, not a panel.
 */
const OPAQUE_OK: RegExp[] = [
  /rounded-full bg-white/, // a switch thumb (and the Mono intro's knob)
  /rounded-full bg-content/, // ModelPicker's switch thumb
  /h-0\.5 bg-content/, // a 2px progress bar
  /rounded-r-full bg-content/, // the floating chat's drag handle
  /rounded-full bg-background-base/, // a count or close badge over an icon
  /overflow-hidden bg-background-base/, // a terminal pane's own background under its grid
];

/** Floating things with a shadow and no glass: a ribbon, a pane that becomes a sheet on a narrow window, colour knobs. */
const SHADOW_OK: RegExp[] = [
  /rotate-45 bg-amber-500\/90/, // the dev-only ribbon
  /max-\[950px\]:absolute/, // the inbox list pane, not a surface over the page
  /rounded-full border-2 border-white/, // the colour picker's handles
];

/** A floating card may show its glass through a backdrop child instead of a class of its own. */
function backdropInside(file: string, index: number): boolean {
  return lines(file)
    .slice(index, index + 5)
    .some((line) => line.includes("<GlassBackdrop"));
}

function offenders(flags: (line: string) => boolean, allowed: RegExp[]): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    lines(file).forEach((text, index) => {
      if (!flags(text)) return;
      if (allowed.some((rule) => rule.test(text))) return;
      found.push(`${file}:${index + 1}: ${text.trim()}`);
    });
  }
  return found;
}

describe("floating surfaces follow the theme", () => {
  it("none paints an opaque background of its own", () => {
    expect(offenders((line) => FLOATING.test(line) && OPAQUE.test(line), OPAQUE_OK)).toEqual([]);
  });

  it("every floating card with a shadow shows glass, by class or a GlassBackdrop inside it", () => {
    const bare: string[] = [];
    for (const file of FILES) {
      lines(file).forEach((text, index) => {
        if (!FLOATING.test(text) || !SHADOW.test(text) || GLASS.test(text)) return;
        if (SHADOW_OK.some((rule) => rule.test(text))) return;
        if (backdropInside(file, index)) return;
        bare.push(`${file}:${index + 1}: ${text.trim()}`);
      });
    }
    expect(bare).toEqual([]);
  });
});
