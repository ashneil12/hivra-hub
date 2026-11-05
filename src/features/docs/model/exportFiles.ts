// A page exports as `<slug>.md`. A tree exports as `<slug>/index.md` with children
// under `<slug>/`, so a file and a directory never share a name. Slugs are the
// ones notes already store. `..`, slashes and a missing slug are refused.

import { blocksToMarkdown, markdownToBlocks, type LinkResolver } from "./markdown";
import type { Block } from "./types";

export type ExportPage = {
  id: string;
  slug: string;
  title: string;
  body: string;
  blocks: readonly Block[] | null;
  parentId: string | null;
  trashed: boolean;
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function safeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!SLUG.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error("This page has no safe file name");
  }
  return trimmed;
}

function childrenOf(pages: readonly ExportPage[], parentId: string): ExportPage[] {
  return pages.filter((page) => page.parentId === parentId && !page.trashed);
}

function pageMarkdown(page: ExportPage, resolver: LinkResolver): string {
  const blocks = page.blocks ?? markdownToBlocks(page.body);
  const title = page.title.trim();
  const body = blocksToMarkdown(blocks, resolver);
  if (!title) return body;
  const heading = `# ${title}`;
  return body ? `${heading}\n\n${body}` : `${heading}\n`;
}

export type ExportFile = { path: string; markdown: string };

/**
 * Files for one page, or for a page and the pages under it. Trashed pages are skipped.
 * Paths are relative, use `/`, and never contain `..`.
 */
export function exportTree(pages: readonly ExportPage[], rootId: string, tree: boolean, resolver: LinkResolver): ExportFile[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const root = byId.get(rootId);
  if (!root || root.trashed) throw new Error("Page was not found");
  const files: ExportFile[] = [];
  const seen = new Set<string>();
  const visit = (page: ExportPage, directory: string) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    const slug = safeSlug(page.slug);
    const kids = childrenOf(pages, page.id);
    const nested = tree && (page.id === rootId || kids.length > 0);
    const path = nested ? `${directory}${slug}/index.md` : `${directory}${slug}.md`;
    if (path.split("/").some((part) => part === ".." || part === "." || part.includes("\\"))) {
      throw new Error("This page has no safe file name");
    }
    files.push({ path, markdown: pageMarkdown(page, resolver) });
    if (!tree) return;
    for (const child of kids) visit(child, `${directory}${slug}/`);
  };
  visit(root, "");
  return files;
}
