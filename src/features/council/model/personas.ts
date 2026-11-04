// WP-23: a council persona is a markdown file. The shape is the one WP-30's check_persona accepts: frontmatter with
// `name` equal to the file's id and a description, then the persona's own text. Extra keys (weight, model) are kept.
// The 18 personas shipped by council-of-high-intelligence are MIT and were not in this checkout, so they are not
// invented here. A plugin (WP-30) adds files in this shape and they are read below.

export type CouncilPersona = {
  id: string;
  name: string;
  description: string;
  /** The persona's text, with the frontmatter removed. This is what the seat is told. */
  body: string;
  /** A vote weight from the file. Anything that is not a finite number above 0 and at most 10 is ignored (the seat votes 1). */
  weight?: number;
  model?: string;
};

const WEIGHT_MAX = 10;

/**
 * Read one persona file. `id` is the file name without `.md`. A file that is not the shape above is skipped, not thrown:
 * a plugin's files are untrusted.
 */
export function parsePersona(id: string, markdown: string): CouncilPersona | null {
  const wanted = id.trim();
  if (!wanted || wanted.includes("/") || wanted.includes("\\") || wanted.includes("..")) return null;
  const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const body = text.slice(end + 5).trim();
  if (!body) return null;
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) return null;
    fields[match[1]] = match[2].trim();
  }
  if (fields.name !== wanted || !fields.description) return null;
  const persona: CouncilPersona = { id: wanted, name: fields.name, description: fields.description, body };
  if (fields.weight !== undefined && fields.weight !== "") {
    const weight = Number(fields.weight);
    if (Number.isFinite(weight) && weight > 0 && weight <= WEIGHT_MAX) persona.weight = weight;
  }
  if (fields.model) persona.model = fields.model;
  return persona;
}

/**
 * Personas shipped with the app, then ones a plugin added. The same id twice keeps the first. A plugin file that does
 * not parse is skipped and the rest are kept.
 */
export function combinePersonas(bundled: readonly CouncilPersona[], extras: readonly { id: string; markdown: string }[]): CouncilPersona[] {
  const out: CouncilPersona[] = [];
  const seen = new Set<string>();
  for (const persona of bundled) {
    if (seen.has(persona.id)) continue;
    seen.add(persona.id);
    out.push(persona);
  }
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    const parsed = parsePersona(extra.id, extra.markdown);
    if (!parsed) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}
