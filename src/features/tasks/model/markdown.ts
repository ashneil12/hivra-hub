// A small markdown reader for a task description. It returns text nodes, never raw HTML, so a
// pasted script stays text and a javascript: link is not a link.

export type MdNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: MdNode[] }
  | { type: "em"; children: MdNode[] }
  | { type: "link"; href: string; children: MdNode[] }
  | { type: "paragraph"; children: MdNode[] }
  | { type: "heading"; children: MdNode[] }
  | { type: "item"; children: MdNode[] };

const SAFE_LINK = /^(https?:|mailto:)/i;

function inline(source: string): MdNode[] {
  const nodes: MdNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((?:[^()]|\([^()]*\))*\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push({ type: "text", text: source.slice(cursor, at) });
    const token = match[0];
    if (token.startsWith("`")) nodes.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) nodes.push({ type: "strong", children: [{ type: "text", text: token.slice(2, -2) }] });
    else if (token.startsWith("*")) nodes.push({ type: "em", children: [{ type: "text", text: token.slice(1, -1) }] });
    else {
      const link = /^\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = (link?.[2] ?? "").trim();
      if (SAFE_LINK.test(href)) nodes.push({ type: "link", href, children: [{ type: "text", text: label }] });
      else nodes.push({ type: "text", text: label });
    }
    cursor = at + token.length;
  }
  if (cursor < source.length) nodes.push({ type: "text", text: source.slice(cursor) });
  return nodes;
}

/** Blocks of a description. An empty string is no blocks. */
export function parseMarkdown(source: string): MdNode[] {
  const text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.trim() === "") return [];
  const blocks: MdNode[] = [];
  for (const part of text.split(/\n{2,}/)) {
    const lines = part.split("\n");
    if (lines.every((line) => /^[-*] /.test(line.trim()))) {
      for (const line of lines) blocks.push({ type: "item", children: inline(line.trim().replace(/^[-*] /, "")) });
      continue;
    }
    const heading = /^(#{1,3}) /.exec(lines[0] ?? "");
    if (heading && lines.length === 1) {
      blocks.push({ type: "heading", children: inline((lines[0] ?? "").slice(heading[0].length)) });
      continue;
    }
    blocks.push({ type: "paragraph", children: inline(lines.join("\n")) });
  }
  return blocks;
}

export function markdownText(nodes: readonly MdNode[]): string {
  return nodes.map((node) => ("text" in node ? node.text : markdownText(node.children))).join("");
}
