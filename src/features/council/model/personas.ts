// WP-23: a council persona is a markdown file. The shape is the one WP-30's check_persona accepts: frontmatter with
// `name` equal to the file's id and a description, then the persona's own text. Extra keys (weight, model) are kept.
// The 18 personas in ../personas are copied from council-of-high-intelligence (MIT). A plugin (WP-30) adds more.

export type CouncilPersona = {
  id: string;
  name: string;
  description: string;
  /** The persona's text, with the frontmatter removed. This is what the seat is told. */
  body: string;
  /** A vote weight from the file. Anything that is not a finite number above 0 and at most 10 is ignored (the seat votes 1). */
  weight?: number;
  model?: string;
  /** `reasoning_method` from the file, including one nested under `council:`. */
  method?: string;
};

const bundledFiles = import.meta.glob("../personas/council-*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The 18 personas shipped with the app. A file that does not parse is left out. */
export function bundledPersonas(): CouncilPersona[] {
  const out: CouncilPersona[] = [];
  for (const [path, markdown] of Object.entries(bundledFiles)) {
    const id = path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    const persona = parsePersona(id, markdown);
    if (persona) out.push(persona);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

const WEIGHT_MAX = 10;

/**
 * Read one persona file. `id` is the file name without `.md`. A file that is not the shape above is skipped, not thrown:
 * a plugin's files are untrusted.
 */
export function parsePersona(id: string, markdown: string): CouncilPersona | null {
  const wanted = id.trim();
  if (!wanted || wanted.includes("/") || wanted.includes("\\") || wanted.includes("..")) return null;
  const text = withoutPreamble(markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const body = text.slice(end + 5).trim();
  if (!body) return null;
  const fields: Record<string, string> = {};
  let method: string | undefined;
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    // Nested YAML (the upstream `council:` block) is kept as data we do not need, except the reasoning method.
    if (/^\s/.test(line)) {
      const nested = /^\s+reasoning_method:\s*(.*)$/.exec(line);
      if (nested && nested[1].trim()) method = nested[1].trim();
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) return null;
    fields[match[1]] = unquote(match[2].trim());
  }
  if (fields.name !== wanted || !fields.description) return null;
  const persona: CouncilPersona = { id: wanted, name: fields.name, description: fields.description, body };
  if (fields.weight !== undefined && fields.weight !== "") {
    const weight = Number(fields.weight);
    if (Number.isFinite(weight) && weight > 0 && weight <= WEIGHT_MAX) persona.weight = weight;
  }
  if (fields.model) persona.model = fields.model;
  if (fields.reasoning_method) method = fields.reasoning_method;
  if (method) persona.method = method;
  return persona;
}

/** A leading licence comment is not frontmatter. The file may carry one and still parse. */
function withoutPreamble(text: string): string {
  let rest = text.trimStart();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->");
    if (end < 0) return rest;
    rest = rest.slice(end + 3).trimStart();
  }
  return rest;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
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
