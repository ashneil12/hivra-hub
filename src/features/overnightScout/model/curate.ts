// WP-165: a draft has to name a source already in the table. Nothing else is proposed.

export type SourceRow = {
  name: string;
  licence: string;
  takes: string;
  packages: number[];
};

export type Proposal = {
  source: string;
  licence: string;
  takes: string;
  packages: number[];
  title: string;
  note: string;
};

const HOME = `/${"Users"}/`;
const WINDOWS_HOME = `${"\\"}Users${"\\"}`;

/** A home path does not belong in a draft. */
export function looksPrivate(text: string): boolean {
  return text.includes(HOME) || text.includes(WINDOWS_HOME) || text.includes("\0");
}

/** Rows of the sources table. The vision list is not a source. */
export function parseSources(text: string): SourceRow[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const start = text.indexOf("## The sources");
  const from = start >= 0 ? text.slice(start) : text;
  const end = from.indexOf("## Vision to packages");
  const table = end >= 0 ? from.slice(0, end) : from;
  const rows: SourceRow[] = [];
  for (const line of table.split(/\r?\n/)) {
    if (!line.startsWith("| [")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const name = /^\[([^\]]+)\]/.exec(cells[0])?.[1]?.trim();
    if (!name || looksPrivate(name) || looksPrivate(cells[2])) continue;
    const packages = [...cells[4].matchAll(/\d+/g)].map((match) => Number(match[0]));
    rows.push({ name, licence: cells[1], takes: cells[2], packages });
  }
  return rows;
}

function sourceFor(label: string, sources: readonly SourceRow[]): SourceRow | undefined {
  const named = sources.find((row) => row.name.toLowerCase() === label.toLowerCase());
  if (named) return named;
  const number = /^(?:WP-)?(\d+)$/i.exec(label);
  if (!number) return undefined;
  const wp = Number(number[1]);
  return sources.find((row) => row.packages.includes(wp));
}

/**
 * One proposal per watch line that names a source in the table.
 * A line with no source is dropped. Sources that nobody named are not turned into drafts.
 */
export function curate(sourcesText: string, watchText: string): Proposal[] {
  const sources = parseSources(sourcesText);
  if (!sources.length || typeof watchText !== "string" || !watchText.trim()) return [];
  const seen = new Set<string>();
  const proposals: Proposal[] = [];
  for (const raw of watchText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let label = "";
    let title = "";
    let note = "";
    if (line.includes("|")) {
      const parts = line.split("|").map((part) => part.trim());
      label = parts[0] ?? "";
      title = parts[1] ?? "";
      note = parts.slice(2).join(" | ").trim();
    } else {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      label = line.slice(0, colon).trim();
      title = line.slice(colon + 1).trim();
    }
    if (!label || !title || looksPrivate(title) || looksPrivate(note)) continue;
    const source = sourceFor(label, sources);
    if (!source) continue;
    const key = `${source.name.toLowerCase()}\0${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push({
      source: source.name,
      licence: source.licence,
      takes: source.takes,
      packages: source.packages,
      title,
      note,
    });
  }
  return proposals;
}

/** The brief quotes the source row and the person's line. It does not add a feature. */
export function briefText(proposal: Proposal): string {
  const packages = proposal.packages.length ? proposal.packages.join(", ") : "none listed";
  const lines = [
    `Source: ${proposal.source} (${proposal.licence}).`,
    `Already taken: ${proposal.takes}`,
    `Packages: ${packages}.`,
    `The person asked: ${proposal.title}.`,
  ];
  if (proposal.note) lines.push(`Note: ${proposal.note}`);
  lines.push("This draft does not start work.");
  return lines.join("\n");
}
