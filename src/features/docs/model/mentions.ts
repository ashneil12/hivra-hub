// Mention rules translated from Orbit page_mentions.rs (WP-72): a mention already
// on the page is not new the next time it is saved. Hivra names pages, tasks,
// chats and Monos. There is no inbox here; the caller hears which ones are new.

import { isSafeFileUrl } from "./links";
import { type Block, type Inline, type MentionKind, type MentionTarget, isMentionKind } from "./types";

export type StoredMention = { kind: MentionKind; targetId: string; name: string };

function mentionOf(part: Inline): StoredMention | null {
  if (part.type !== "mention") return null;
  const { kind, targetId, name } = part.props;
  if (!isMentionKind(kind) || !targetId) return null;
  return { kind, targetId, name: name.trim() || targetId };
}

function walkInline(content: unknown, out: StoredMention[]) {
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && "rows" in content) {
      const rows = (content as { rows?: { cells?: { content?: unknown }[] }[] }).rows ?? [];
      for (const row of rows) for (const cell of row.cells ?? []) walkInline(cell.content, out);
    }
    return;
  }
  for (const part of content as Inline[]) {
    const mention = mentionOf(part);
    if (mention) out.push(mention);
    if (part.type === "link") walkInline(part.content, out);
  }
}

function walk(blocks: readonly Block[], out: StoredMention[]) {
  for (const block of blocks) {
    walkInline(block.content, out);
    if (block.type === "page" && typeof block.props.pageId === "string" && block.props.pageId) {
      out.push({ kind: "page", targetId: block.props.pageId, name: block.props.pageId });
    }
    walk(block.children, out);
  }
}

/** First time each target is mentioned, in reading order. */
export function mentionsIn(blocks: readonly Block[]): StoredMention[] {
  const out: StoredMention[] = [];
  walk(blocks, out);
  const seen = new Set<string>();
  return out.filter((mention) => {
    const key = `${mention.kind}:${mention.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Mentions in `after` that were not in `before`. */
export function newMentions(before: readonly StoredMention[], after: readonly StoredMention[]): StoredMention[] {
  const had = new Set(before.map((mention) => `${mention.kind}:${mention.targetId}`));
  return after.filter((mention) => !had.has(`${mention.kind}:${mention.targetId}`));
}

export type ResolvedMention = StoredMention & { found: boolean };

/**
 * Resolves a mention against a catalog the caller trusts (pages, tasks, chats, Monos).
 * A task with no row — WP-70 is not merged, so the catalog has no tasks — is not found,
 * and that is not a failure.
 */
export function resolveMention(
  mention: StoredMention,
  catalog: readonly (MentionTarget & { slug?: string })[],
): ResolvedMention {
  const hit = catalog.find((target) => {
    if (target.kind !== mention.kind) return false;
    if (target.id === mention.targetId) return true;
    return mention.kind === "page" && target.slug === mention.targetId;
  });
  if (!hit) return { ...mention, found: false };
  return { kind: hit.kind, targetId: hit.id, name: hit.name, found: true };
}

export function resolveMentions(
  mentions: readonly StoredMention[],
  catalog: readonly (MentionTarget & { slug?: string })[],
): ResolvedMention[] {
  return mentions.map((mention) => resolveMention(mention, catalog));
}

/** Image and file blocks whose URL is a note asset of this page. */
export function noteAssetUrls(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const visit = (list: readonly Block[]) => {
    for (const block of list) {
      if ((block.type === "image" || block.type === "file") && isSafeFileUrl(block.props.url) && block.props.url) {
        out.push(String(block.props.url));
      }
      visit(block.children);
    }
  };
  visit(blocks);
  return out;
}
