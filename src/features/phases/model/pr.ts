// WP-84: the pull request names the phase documents. A straight build adds nothing.

const LINKED = new Set(["research", "design", "product", "technical"]);

function linkText(value: string): string {
  return value.replace(/[\r\n[\]]/g, " ").replace(/\s+/g, " ").trim();
}

export type PhaseDocLink = { title: string; href: string };

export function phaseDocLinks(docs: readonly { phase: string; title: string; fileName: string; number: number }[]): PhaseDocLink[] {
  const linked = [...docs].filter((doc) => LINKED.has(doc.phase)).sort((a, b) => a.number - b.number);
  const lines: PhaseDocLink[] = [];
  for (const doc of linked) {
    const title = linkText(doc.title);
    const href = doc.fileName.trim();
    if (!title || !href || /[\s()]/.test(href)) continue;
    lines.push({ title, href });
  }
  return lines;
}

export function phaseLinks(docs: readonly { phase: string; title: string; fileName: string; number: number }[]): string {
  const lines = phaseDocLinks(docs);
  if (lines.length === 0) return "";
  return `## Phase documents\n\n${lines.map((line) => `- [${line.title}](${line.href})`).join("\n")}\n`;
}
