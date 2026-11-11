import { BUILT_IN_SCHEMES, contrast, hexToRgb, hslToRgb, type ThemeScheme } from "../../settings/model/themeSchemes";
import type { BespokeSpec } from "./pageSpec";

/**
 * The design check every bespoke page goes through before it reaches the preview (docs/pages-build-contract.md).
 * One thing blocks: small text below 4.5:1 in any scheme. Everything else is a warning shown in the preview with a
 * "Fix it" offer; Keep and allow still works with warnings showing.
 */
export type DesignIssue = { rule: "contrast" | "own-colours" | "status-colours"; plain: string };
export type DesignResult = { blocked?: DesignIssue; warnings: DesignIssue[] };

type Rgb = [number, number, number];
type Rule = { selector: string; body: string };
const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const STATUS_VAR = /var\(--color-status-(ok|warn|bad)\)/;

function rules(spec: Pick<BespokeSpec, "html" | "css">): Rule[] {
  const out: Rule[] = [];
  for (const m of (spec.css ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim(), body: m[2] });
  for (const m of spec.html.matchAll(/<([a-z0-9-]+)([^>]*?)\sstyle\s*=\s*"([^"]*)"/gi)) out.push({ selector: `${m[1]}${m[2]}`, body: m[3] });
  return out;
}
const prop = (body: string, name: string) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1]?.trim();

function schemeColours(s: Pick<ThemeScheme, "hue" | "saturation" | "lightness">) {
  const bg = hslToRgb(s.hue, s.saturation, s.lightness);
  const content = hslToRgb(s.hue, s.saturation, 92);
  const surface = content.map((v, i) => v * 0.08 + bg[i] * 0.92) as Rgb;
  return { content, surface };
}
function literalRgb(v: string): Rgb | undefined {
  const hex = v.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i)?.[1];
  if (hex) return hexToRgb(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex);
  const rgb = v.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = v.match(/hsla?\(\s*([\d.]+)[ ,]+([\d.]+)%[ ,]+([\d.]+)%/i);
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  return undefined;
}
/** The text colour a rule draws in a scheme, laid over the raised surface (the worst case for small text). */
function textOn(colour: string, opacity: number, s: ThemeScheme): { fg: Rgb; bg: Rgb } | undefined {
  const { content, surface } = schemeColours(s);
  let fg: Rgb | undefined;
  let alpha = opacity;
  const mixed = colour.match(/color-mix\(\s*in srgb\s*,\s*var\(--color-content\)\s+([\d.]+)%/i);
  if (mixed) { fg = content; alpha *= Number(mixed[1]) / 100; }
  else if (/var\(--color-content\)/.test(colour)) fg = content;
  else fg = literalRgb(colour);
  if (!fg) return undefined;
  return { fg: fg.map((v, i) => v * alpha + surface[i] * (1 - alpha)) as Rgb, bg: surface };
}

export function checkBespokePage(spec: Pick<BespokeSpec, "html" | "css" | "js">, schemes: readonly ThemeScheme[] = BUILT_IN_SCHEMES): DesignResult {
  const warnings: DesignIssue[] = [];
  let blocked: DesignIssue | undefined;
  for (const r of rules(spec)) {
    const colour = prop(r.body, "color");
    if (!colour || blocked) continue;
    const opacity = Number(prop(r.body, "opacity") ?? 1);
    for (const s of schemes) {
      const t = textOn(colour, Number.isFinite(opacity) ? opacity : 1, s);
      if (!t) continue;
      const ratio = contrast(t.fg, t.bg);
      if (ratio < 4.5) {
        blocked = { rule: "contrast", plain: `Text in “${r.selector}” is too faint to read in the ${s.name} scheme (${ratio.toFixed(1)}:1; it needs 4.5:1).` };
        break;
      }
    }
  }
  if (LITERAL.test(`${spec.css ?? ""}\n${spec.html}\n${spec.js ?? ""}`))
    warnings.push({ rule: "own-colours", plain: "It uses its own colours instead of the theme's, so it won't change with your scheme." });
  if (rules(spec).some((r) => STATUS_VAR.test(r.body) && !/status|data-state/i.test(r.selector)))
    warnings.push({ rule: "status-colours", plain: "It uses red, amber or green for decoration. Those colours mean status in the app." });
  return { blocked, warnings };
}
