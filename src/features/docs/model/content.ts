// SPDX-License-Identifier: Apache-2.0
// Adapted from github.com/coollabsio/orbit apps/web/src/features/docs/editor/content.ts (WP-72).
// The upstream file does not carry a separate copyright line.
// Orbit's file URLs are workspace API paths. Hivra's are note assets and http(s),
// so the allow-list is isSafeFileUrl. Task-attachment copying is not ported.

import { isSafeFileUrl, normalizeLinkHref } from "./links";
import type { Block, Inline } from "./types";

export const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
  "callout",
  "codeBlock",
  "image",
  "file",
  "divider",
  "table",
  "page",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeLinks(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (isRecord(item) && item.type === "link") {
        const href = normalizeLinkHref(item.href);
        const content = Array.isArray(item.content) ? item.content : [];
        if (href) out.push({ ...item, href, content: sanitizeLinks(content) });
        else out.push(...(sanitizeLinks(content) as unknown[]));
        continue;
      }
      out.push(sanitizeLinks(item));
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeLinks(child);
    return out;
  }
  return value;
}

function sanitizeFiles(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    let next = block;
    if ((block.type === "image" || block.type === "file") && !isSafeFileUrl(block.props.url)) {
      next = { ...block, props: { ...block.props, url: "" } };
    }
    return { ...next, children: sanitizeFiles(block.children) };
  });
}

/** Drops unknown block types, unsafe links and unsafe file URLs. Empty becomes no blocks. */
export function toStoredContent(blocks: readonly Block[]): Block[] {
  const known = blocks.filter((block) => BLOCK_TYPES.has(block.type));
  const linked = sanitizeLinks(known) as Block[];
  return sanitizeFiles(linked).map((block) => ({ ...block, children: toStoredContent(block.children) }));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Equal ignoring object key order, so a save echo does not look like a change. */
export function contentEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function inlineText(content: Inline[] | unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return String(part.text ?? "");
      if (part.type === "link") return inlineText(part.content);
      if (part.type === "mention") return `@${part.props?.kind ?? ""}/${part.props?.targetId ?? ""}`;
      return "";
    })
    .join("");
}
