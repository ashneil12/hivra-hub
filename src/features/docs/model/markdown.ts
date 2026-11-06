// SPDX-License-Identifier: Apache-2.0
// Translated from github.com/coollabsio/orbit apps/server/src/collab/markdown_import.rs
// and apps/server/src/export/markdown.rs (WP-72). The upstream files do not carry
// a separate copyright line.
// The Yjs round trip at the end of markdown_to_blocks is not ported: live
// co-editing is WP-80, so schema defaults are filled in here instead.
// pulldown-cmark is Rust and is not fetched here; this reader follows the same
// block decisions (image split, mention longest unique name, depth flatten,
// adjacent text merge, fence length). A callout and a file are recovered on
// the way back in, because Orbit writes them as an emoji blockquote and a lone
// link and Hivra has to keep those block types.

import { isSafeFileUrl, internalPageLinkId, normalizeLinkHref } from "./links";
import {
  type Block,
  type Inline,
  type InlineText,
  type MentionKind,
  type MentionTarget,
  isMentionKind,
} from "./types";

/** Same cap as Orbit's `MAX_BLOCK_DEPTH`. Deeper markdown becomes paragraphs. */
export const MAX_BLOCK_DEPTH = 50;

const CALLOUT_EMOJI = "💡";

const LIST_TYPES = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"];

export type PageLink = { title: string; href: string };

/** Rewrites references while converting. Missing pages render as "Missing page". */
export type LinkResolver = {
  page: (pageId: string) => PageLink | null;
  url: (url: string) => string;
  mentionName?: (targetId: string) => string | undefined;
};

/** Keeps every URL and links pages to `/docs/<id>` titled "Untitled". */
export const keepLinks: LinkResolver = {
  page: (pageId) =>
    pageId ? { title: "Untitled", href: `/docs/${pageId}` } : null,
  url: (url) => url,
};

type Styles = Record<string, boolean>;

type Piece =
  | { kind: "text"; text: string; styles: Styles }
  | { kind: "link"; href: string; content: InlineText[] }
  | { kind: "image"; url: string; alt: string };

function textInline(text: string, styles: Styles): InlineText {
  const cleaned: Styles = {};
  for (const [key, on] of Object.entries(styles)) if (on) cleaned[key] = true;
  return { type: "text", text, styles: cleaned };
}

function sameStyles(a: Styles, b: Styles): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (Boolean(a[key]) !== Boolean(b[key])) return false;
  return true;
}

function mergeText(content: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const item of content) {
    const last = out[out.length - 1];
    if (last && last.type === "text" && item.type === "text" && sameStyles(last.styles, item.styles)) {
      last.text += item.text;
      continue;
    }
    out.push(item);
  }
  return out;
}

function defaults(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> =
    type === "heading"
      ? { level: 1 }
      : type === "checkListItem"
        ? { checked: false }
        : type === "codeBlock"
          ? { language: "" }
          : type === "image"
            ? { url: "", caption: "", name: "", previewWidth: 512 }
            : type === "file"
              ? { url: "", name: "", caption: "" }
              : type === "callout"
                ? { emoji: CALLOUT_EMOJI, backgroundColor: "gray", textColor: "default" }
                : type === "page"
                  ? { pageId: "" }
                  : {};
  return { ...base, ...props };
}

function makeBlock(
  id: () => string,
  type: string,
  props: Record<string, unknown>,
  content: Block["content"],
  children: Block[] = [],
): Block {
  return { id: id(), type, props: defaults(type, props), content, children };
}

function isEmojiToken(token: string): boolean {
  if (!token || /[A-Za-z0-9]/.test(token)) return false;
  return /\p{Extended_Pictographic}/u.test(token);
}

function fitsName(text: string, name: string): boolean {
  if (!name || !text.startsWith(name)) return false;
  const next = text.slice(name.length);
  return next.length === 0 || !/^[\p{L}\p{N}]/u.test(next);
}

/** Longest unique catalog name that starts `text`, unless two share that length. */
export function matchingTarget(text: string, members: readonly MentionTarget[]): MentionTarget | null {
  const hits = members.filter((member) => member.name && fitsName(text, member.name));
  if (hits.length === 0) return null;
  const longest = Math.max(...hits.map((member) => member.name.length));
  const top = hits.filter((member) => member.name.length === longest);
  return top.length === 1 ? top[0] : null;
}

const STRUCTURED_MENTION = /^(page|task|chat|mono|note)\/([A-Za-z0-9_-]{1,128})/;

function mentionFrom(kind: string, targetId: string, name: string): Inline {
  const resolved: MentionKind = kind === "note" || !isMentionKind(kind) ? "page" : kind;
  return { type: "mention", props: { kind: resolved, targetId, name: name || targetId } };
}

function applyMentions(content: Inline[], members: readonly MentionTarget[]): Inline[] {
  const out: Inline[] = [];
  for (const item of content) {
    if (item.type !== "text" || item.styles.code) {
      out.push(item);
      continue;
    }
    let rest = item.text;
    let before = "";
    while (rest.includes("@")) {
      const at = rest.indexOf("@");
      const prior = (before + rest.slice(0, at)).slice(-1);
      const boundary = prior.length === 0 || !/^[\p{L}\p{N}]$/u.test(prior);
      const after = rest.slice(at + 1);
      const structured = boundary ? STRUCTURED_MENTION.exec(after) : null;
      const named = !structured && boundary ? matchingTarget(after, members) : null;
      if (structured) {
        before += rest.slice(0, at);
        if (before) out.push(textInline(before, item.styles));
        before = "";
        const kind = structured[1];
        const targetId = structured[2];
        out.push(mentionFrom(kind, targetId, targetId));
        rest = after.slice(structured[0].length);
        continue;
      }
      if (named) {
        before += rest.slice(0, at);
        if (before) out.push(textInline(before, item.styles));
        before = "";
        out.push(mentionFrom(named.kind, named.id, named.name));
        rest = after.slice(named.name.length);
        continue;
      }
      before += rest.slice(0, at + 1);
      rest = after;
    }
    before += rest;
    if (before) out.push(textInline(before, item.styles));
  }
  return out;
}

function parseInline(src: string, styles: Styles = {}): Piece[] {
  const out: Piece[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf, styles: { ...styles } });
    buf = "";
  };
  let i = 0;
  const closeOf = (marker: string, from: number) => {
    const at = src.indexOf(marker, from);
    return at === -1 ? -1 : at;
  };
  while (i < src.length) {
    if (src[i] === "`") {
      const run = /^`+/.exec(src.slice(i))?.[0] ?? "`";
      const close = src.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        let inner = src.slice(i + run.length, close);
        if (inner.startsWith("`") || inner.endsWith("`") || (inner.startsWith(" ") && inner.endsWith(" ") && inner.trim())) {
          // A padded span keeps its edge spaces only when the fence is longer; the reader stored them.
        }
        if (inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() && run.length > 0) {
          // CommonMark trims one space of padding when the span is space-wrapped.
          if (inner.trim()) inner = inner.slice(1, -1);
        }
        out.push({ kind: "text", text: inner, styles: { ...styles, code: true } });
        i = close + run.length;
        continue;
      }
    }
    if (src.startsWith("![", i)) {
      const parsed = readLink(src, i + 1);
      if (parsed) {
        flush();
        out.push({ kind: "image", url: parsed.href, alt: parsed.label });
        i = parsed.end;
        continue;
      }
    }
    if (src[i] === "[") {
      const parsed = readLink(src, i);
      if (parsed) {
        flush();
        const inner = parseInline(parsed.label, styles).filter((piece) => piece.kind === "text") as Array<{
          kind: "text";
          text: string;
          styles: Styles;
        }>;
        const content = mergeText(inner.map((piece) => textInline(piece.text, piece.styles))).filter(
          (part): part is InlineText => part.type === "text",
        );
        out.push({ kind: "link", href: parsed.href, content });
        i = parsed.end;
        continue;
      }
    }
    if (src.startsWith("~~", i)) {
      const close = closeOf("~~", i + 2);
      if (close !== -1) {
        flush();
        out.push(...parseInline(src.slice(i + 2, close), { ...styles, strike: true }));
        i = close + 2;
        continue;
      }
    }
    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const marker = src.slice(i, i + 2);
      const close = closeOf(marker, i + 2);
      if (close !== -1) {
        flush();
        out.push(...parseInline(src.slice(i + 2, close), { ...styles, bold: true }));
        i = close + 2;
        continue;
      }
    }
    if (src[i] === "*" || src[i] === "_") {
      const marker = src[i];
      const word = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
      if (marker === "_" && word(src[i - 1]) && word(src[i + 1])) {
        buf += src[i];
        i += 1;
        continue;
      }
      const close = closeOf(marker, i + 1);
      if (close !== -1 && close !== i + 1) {
        flush();
        out.push(...parseInline(src.slice(i + 1, close), { ...styles, italic: true }));
        i = close + 1;
        continue;
      }
    }
    if (src[i] === "\\") {
      buf += src[i + 1] ?? "\\";
      i += src[i + 1] ? 2 : 1;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}

function readLink(src: string, start: number): { label: string; href: string; end: number } | null {
  if (src[start] !== "[") return null;
  const labelEnd = src.indexOf("]", start + 1);
  if (labelEnd === -1 || src[labelEnd + 1] !== "(") return null;
  const hrefEnd = src.indexOf(")", labelEnd + 2);
  if (hrefEnd === -1) return null;
  return { label: src.slice(start + 1, labelEnd), href: src.slice(labelEnd + 2, hrefEnd), end: hrefEnd + 1 };
}

function piecesToContent(pieces: Piece[], members: readonly MentionTarget[]): { content: Inline[]; images: { url: string; alt: string }[] } {
  const content: Inline[] = [];
  const images: { url: string; alt: string }[] = [];
  for (const piece of pieces) {
    if (piece.kind === "image") images.push({ url: piece.url, alt: piece.alt });
    else if (piece.kind === "link") content.push({ type: "link", href: piece.href, content: piece.content });
    else content.push(textInline(piece.text, piece.styles));
  }
  return { content: applyMentions(mergeText(content), members), images };
}

type ItemMatch = { indent: number; kind: "bullet" | "numbered" | "check"; checked: boolean; number: number; text: string };

function matchItem(line: string): ItemMatch | null {
  const match = /^(\s*)([-+*]|\d{1,9}[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
  if (!match) return null;
  const indent = match[1].length;
  const marker = match[2];
  const box = match[3];
  if (box) {
    return { indent, kind: "check", checked: box.toLowerCase() === "x", number: 0, text: match[4] };
  }
  if (/^\d/.test(marker)) {
    return { indent, kind: "numbered", checked: false, number: Number.parseInt(marker, 10), text: match[4] };
  }
  return { indent, kind: "bullet", checked: false, number: 0, text: match[4] };
}

function isFence(line: string): { char: string; len: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return { char: match[1][0], len: match[1].length, info: match[2].trim() };
}

function isHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isQuote(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string): string[] {
  let raw = line.trim();
  if (raw.startsWith("|")) raw = raw.slice(1);
  if (raw.endsWith("|")) raw = raw.slice(0, -1);
  return raw.split("|").map((cell) => cell.trim());
}

function looksLikeTable(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index].includes("|") && isTableSep(lines[index + 1]);
}

function paragraphEnds(line: string, lines: string[], index: number): boolean {
  if (line.trim() === "") return true;
  return Boolean(isFence(line) || isHeading(line) || isRule(line) || isQuote(line) || matchItem(line) || looksLikeTable(lines, index));
}

type Reader = {
  id: () => string;
  members: readonly MentionTarget[];
};

function paragraphFrom(reader: Reader, text: string, out: Block[], depth: number) {
  if (!text.trim()) return;
  if (depth >= MAX_BLOCK_DEPTH) {
    out.push(makeBlock(reader.id, "paragraph", {}, [textInline(text, {})]));
    return;
  }
  const pieces = parseInline(text);
  const images: { url: string; alt: string }[] = [];
  let run: Piece[] = [];
  const flush = () => {
    const { content } = piecesToContent(run, reader.members);
    run = [];
    if (content.length === 0) return;
    if (content.length === 1 && content[0].type === "link") {
      const link = content[0];
      const pageId = internalPageLinkId(link.href);
      if (pageId) {
        out.push(makeBlock(reader.id, "page", { pageId }, []));
        return;
      }
      if (isSafeFileUrl(link.href) && link.href !== "") {
        const name = link.content.map((part) => part.text).join("") || link.href.split("/").pop() || "File";
        out.push(makeBlock(reader.id, "file", { url: link.href, name, caption: "" }, []));
        return;
      }
    }
    out.push(makeBlock(reader.id, "paragraph", {}, content));
  };
  for (const piece of pieces) {
    if (piece.kind === "image") {
      flush();
      images.push({ url: piece.url, alt: piece.alt });
      out.push(makeBlock(reader.id, "image", { url: piece.url, caption: piece.alt, name: "" }, []));
    } else run.push(piece);
  }
  flush();
  void images;
}

function parseBlocks(text: string, reader: Reader, depth: number): Block[] {
  if (depth >= MAX_BLOCK_DEPTH) {
    const out: Block[] = [];
    for (const line of text.split("\n")) paragraphFrom(reader, line, out, depth);
    return out;
  }
  const lines = text.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = isFence(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = isFence(lines[i]);
        if (close && close.char === fence.char && close.len >= fence.len) {
          i += 1;
          break;
        }
        code.push(lines[i]);
        i += 1;
      }
      let body = code.join("\n");
      if (body.endsWith("\n")) body = body.slice(0, -1);
      const language = fence.info.split(/\s+/)[0] ?? "";
      const content = body ? [textInline(body, {})] : [];
      out.push(makeBlock(reader.id, "codeBlock", { language }, content));
      continue;
    }
    const heading = isHeading(line);
    if (heading) {
      const pieces = piecesToContent(parseInline(heading.text), reader.members);
      out.push(makeBlock(reader.id, "heading", { level: heading.level }, pieces.content));
      i += 1;
      continue;
    }
    if (isRule(line)) {
      out.push(makeBlock(reader.id, "divider", {}, []));
      i += 1;
      continue;
    }
    if (isQuote(line)) {
      const inner: string[] = [];
      while (i < lines.length && (isQuote(lines[i]) || (lines[i].trim() === "" && i + 1 < lines.length && isQuote(lines[i + 1])))) {
        inner.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i += 1;
      }
      const nested = parseBlocks(inner.join("\n"), reader, depth + 1);
      out.push(...wrapQuote(reader, nested));
      continue;
    }
    if (looksLikeTable(lines, i)) {
      const rows: string[][] = [tableCells(lines[i])];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
      out.push(
        makeBlock(reader.id, "table", {}, {
          type: "tableContent",
          columnWidths: Array.from({ length: columns }, () => null),
          headerRows: 1,
          rows: rows.map((row) => ({
            cells: Array.from({ length: columns }, (_, cell) => ({
              type: "tableCell" as const,
              props: {},
              content: piecesToContent(parseInline(row[cell] ?? ""), reader.members).content,
            })),
          })),
        }),
      );
      continue;
    }
    const item = matchItem(line);
    if (item) {
      const parsed = parseList(lines, i, item.indent, reader, depth);
      out.push(...parsed.blocks);
      i = parsed.next;
      continue;
    }
    if (/^ {0,3}</.test(line)) {
      const html: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        html.push(lines[i]);
        i += 1;
      }
      paragraphFrom(reader, html.join("\n").replace(/\n$/, ""), out, depth);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !paragraphEnds(lines[i], lines, i)) {
      para.push(lines[i]);
      i += 1;
    }
    paragraphFrom(reader, para.join("\n"), out, depth);
  }
  return absorbCaptions(out);
}

function wrapQuote(reader: Reader, nested: Block[]): Block[] {
  if (nested.length === 0) return [];
  const [first, ...rest] = nested;
  if (first.type !== "paragraph" && first.type !== "quote") return nested;
  const raw = inlinePlain(first.content);
  const token = raw.trimStart().split(/\s+/)[0] ?? "";
  if (token && isEmojiToken(token)) {
    const text = raw.trimStart().slice(token.length).trimStart();
    return [
      makeBlock(
        reader.id,
        "callout",
        { emoji: token, backgroundColor: "gray", textColor: "default" },
        text ? [textInline(text, {})] : [],
        [...first.children, ...rest],
      ),
    ];
  }
  if (first.type === "paragraph" || first.type === "quote") {
    return [makeBlock(reader.id, "quote", {}, Array.isArray(first.content) ? first.content : [], [...first.children, ...rest])];
  }
  return nested;
}

function inlinePlain(content: Block["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "link") return part.content.map((item) => item.text).join("");
      return "";
    })
    .join("");
}

function soleItalic(block: Block): string | null {
  if (block.type !== "paragraph" || block.children.length !== 0) return null;
  if (!Array.isArray(block.content) || block.content.length !== 1) return null;
  const part = block.content[0];
  if (part.type !== "text" || !part.styles.italic) return null;
  const on = Object.entries(part.styles).filter(([, value]) => value);
  if (on.length !== 1) return null;
  return part.text;
}

function absorbCaptions(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = blocks[i + 1];
    if ((block.type === "image" || block.type === "file") && next) {
      const italic = soleItalic(next);
      if (italic !== null) {
        const caption = String(block.props.caption ?? "");
        if (italic === caption) {
          i += 1;
        } else if (block.type === "image" && caption) {
          block.props.name = caption;
          block.props.caption = italic;
          i += 1;
        } else {
          block.props.caption = italic;
          i += 1;
        }
      }
    }
    block.children = absorbCaptions(block.children);
    out.push(block);
  }
  return out;
}

function parseList(
  lines: string[],
  start: number,
  indent: number,
  reader: Reader,
  depth: number,
): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].trim() === "") break;
    const item = matchItem(lines[i]);
    if (!item || item.indent !== indent) break;
    i += 1;
    // The item's own paragraph runs on lazily: lines set further in than the marker continue the item's text, until a
    // nested list starts or the item ends.
    const own = [item.text];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "" || leadingSpaces(line) <= indent) break;
      if (matchItem(line)) break;
      own.push(line.trim());
      i += 1;
    }
    // WP-102 (Orbit ab86dac): a blank line does not end the item when what follows is set in under it. That is how a
    // paragraph, quote or heading child, or a numbered child list past 1, is written and read back as a child.
    const nested: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        let next = i + 1;
        while (next < lines.length && lines[next].trim() === "") next += 1;
        if (next >= lines.length) {
          i = next;
          break;
        }
        const after = matchItem(lines[next]);
        if (!(after ? after.indent > indent : leadingSpaces(lines[next]) > indent)) break;
        nested.push("");
        i += 1;
        continue;
      }
      const next = matchItem(line);
      if (next && next.indent <= indent) break;
      if (!next && leadingSpaces(line) <= indent) break;
      nested.push(line);
      i += 1;
    }
    const text = own.join("\n");
    const childLines = dedentBlocks(nested);
    const children = depth + 1 >= MAX_BLOCK_DEPTH || childLines.length === 0 ? [] : parseBlocks(childLines, reader, depth + 1);
    if (depth + 1 >= MAX_BLOCK_DEPTH && childLines.length) {
      for (const line of childLines.split("\n")) paragraphFrom(reader, line.trim(), blocks, depth);
    }
    const content = piecesToContent(parseInline(text), reader.members).content;
    if (item.kind === "check") {
      blocks.push(makeBlock(reader.id, "checkListItem", { checked: item.checked }, content, children));
    } else if (item.kind === "numbered") {
      const props = item.number > 1 && blocks.every((block) => block.type !== "numberedListItem") ? { start: item.number } : {};
      blocks.push(makeBlock(reader.id, "numberedListItem", props, content, children));
    } else {
      blocks.push(makeBlock(reader.id, "bulletListItem", {}, content, children));
    }
  }
  return { blocks, next: i };
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

/** A list item's child lines, set in under the marker: the common indent is taken off, blank lines kept. */
function dedentBlocks(lines: readonly string[]): string {
  let least = Infinity;
  for (const line of lines) if (line.trim() !== "") least = Math.min(least, leadingSpaces(line));
  if (!Number.isFinite(least) || least <= 0) return lines.join("\n").trimEnd();
  return lines
    .map((line) => (line.trim() === "" ? "" : line.slice(least)))
    .join("\n")
    .trimEnd();
}

function sanitizeInline(content: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const part of content) {
    if (part.type !== "link") {
      out.push(part);
      continue;
    }
    const href = normalizeLinkHref(part.href);
    if (!href) out.push(...part.content);
    else out.push({ ...part, href });
  }
  return out;
}

function sanitizeBlock(block: Block): Block {
  const content = Array.isArray(block.content)
    ? sanitizeInline(block.content)
    : block.type === "table" && block.content && typeof block.content === "object" && "rows" in block.content
      ? {
          ...block.content,
          rows: (
            block.content as {
              rows: { cells: { type: "tableCell"; props: Record<string, unknown>; content: Inline[] }[] }[];
            }
          ).rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({ ...cell, content: sanitizeInline(cell.content) })),
          })),
        }
      : block.content;
  let props = block.props;
  if ((block.type === "image" || block.type === "file") && !isSafeFileUrl(props.url)) {
    props = { ...props, url: "" };
  }
  return { ...block, props, content, children: block.children.map(sanitizeBlock) };
}

/** Markdown to blocks. `members` are the `@Name` targets (pages, tasks, chats, Monos). */
export function markdownToBlocks(markdown: string, members: readonly MentionTarget[] = []): Block[] {
  const source = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!source.trim()) return [];
  let n = 0;
  const reader: Reader = { id: () => `b${(n += 1)}`, members };
  return parseBlocks(source, reader, 0).map(sanitizeBlock);
}

// --- blocks to markdown (export/markdown.rs) ---

type Mode = "block" | "line" | "cell";

type StyleFlags = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; code: boolean };

function styleFlags(value: unknown): StyleFlags {
  const styles = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const flag = (name: string) => styles[name] === true || styles[name] === "true";
  return { bold: flag("bold"), italic: flag("italic"), underline: flag("underline"), strike: flag("strike"), code: flag("code") };
}

const EMPTY_STYLES: StyleFlags = { bold: false, italic: false, underline: false, strike: false, code: false };

function escapeText(text: string, cell: boolean): string {
  const characters = [...text];
  let out = "";
  characters.forEach((character, index) => {
    const word = (other: string | undefined) => !!other && /[\p{L}\p{N}]/u.test(other);
    const escape =
      "\\`*[]<>~".includes(character) ||
      (character === "|" && cell) ||
      (character === "_" && !(word(characters[index - 1]) && word(characters[index + 1])));
    if (escape) out += "\\";
    out += character;
  });
  return out;
}

function escapeLineStart(line: string): string {
  const trimmed = line.trimStart();
  const lead = line.slice(0, line.length - trimmed.length);
  const first = trimmed[0];
  if (first && "#>=+-".includes(first)) return `${lead}\\${trimmed}`;
  if (first && /[0-9]/.test(first)) {
    const digits = /^[0-9]+/.exec(trimmed)?.[0].length ?? 0;
    if (digits > 0 && digits <= 9 && (trimmed[digits] === "." || trimmed[digits] === ")")) {
      return `${lead}${trimmed.slice(0, digits)}\\${trimmed.slice(digits)}`;
    }
  }
  return line;
}

function longestRun(text: string, target: string): number {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    if (character === target) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function codeSpan(text: string): string {
  const fence = "`".repeat(longestRun(text, "`") + 1);
  if (text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim())) {
    return `${fence} ${text} ${fence}`;
  }
  return `${fence}${text}${fence}`;
}

function styled(text: string, styles: StyleFlags, mode: Mode): string {
  const core = text.trim().length === text.trimStart().length && text.trim().length === text.trimEnd().length
    ? text.trim()
    : text.replace(/^[ \t]+|[ \t]+$/g, (spaces) => spaces).trim() || text;
  // Whitespace at the edges stays outside the markers.
  const match = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(text);
  const lead = match?.[1] ?? "";
  const bodyText = match?.[2] ?? text;
  const trail = match?.[3] ?? "";
  if (!bodyText.trim()) return text;
  let body = styles.code ? codeSpan(bodyText) : escapeText(bodyText, mode === "cell");
  if (styles.underline) body = `<u>${body}</u>`;
  if (styles.strike) body = `~~${body}~~`;
  if (styles.italic) body = `*${body}*`;
  if (styles.bold) body = `**${body}**`;
  void core;
  return `${lead}${body}${trail}`;
}

function runsMarkdown(runs: Array<[string, StyleFlags]>, mode: Mode): string {
  let out = "";
  for (const [text, styles] of runs) {
    text.split("\n").forEach((piece, index) => {
      if (index > 0) out += mode === "block" ? "\\\n" : mode === "line" ? " " : "<br>";
      out += styled(piece, styles, mode);
    });
  }
  return out;
}

function pushRun(runs: Array<[string, StyleFlags]>, text: string, styles: StyleFlags) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && JSON.stringify(last[1]) === JSON.stringify(styles)) last[0] += text;
  else runs.push([text, styles]);
}

function textRuns(value: unknown): Array<[string, StyleFlags]> {
  const runs: Array<[string, StyleFlags]> = [];
  if (typeof value === "string") pushRun(runs, value, EMPTY_STYLES);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") pushRun(runs, item, EMPTY_STYLES);
      else if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
        pushRun(runs, item.text, styleFlags("styles" in item ? item.styles : undefined));
      } else if (item && typeof item === "object" && "content" in item) {
        for (const run of textRuns(item.content)) pushRun(runs, run[0], run[1]);
      }
    }
  }
  return runs;
}

function plainText(value: unknown): string {
  return textRuns(value).map(([text]) => text).join("");
}

function propStr(block: Block, name: string): string {
  const value = block.props[name];
  return typeof value === "string" ? value : "";
}

function propBool(block: Block, name: string): boolean {
  const value = block.props[name];
  return value === true || value === "true";
}

function propNumber(block: Block, name: string): number | null {
  const value = block.props[name];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

function quoteText(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function continuesItem(line: string): boolean {
  const item = matchItem(line);
  return item !== null && (item.kind !== "numbered" || item.number === 1);
}

function indentText(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? `${first}${line}` : line ? `${rest}${line}` : line))
    .join("\n");
}

function joinBlocks(head: string, rest: string): string {
  if (!head) return rest;
  if (!rest) return head;
  return `${head}\n\n${rest}`;
}

function linkDestination(url: string): string {
  let out = "";
  for (const character of url) {
    if (character === " ") out += "%20";
    else if (character === "(") out += "%28";
    else if (character === ")") out += "%29";
    else if (character === "<") out += "%3C";
    else if (character === ">") out += "%3E";
    else if (character.charCodeAt(0) < 32) {
      const bytes = new TextEncoder().encode(character);
      for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else out += character;
  }
  return out;
}

function escapeLabel(text: string): string {
  return escapeText(text, false);
}

class Converter {
  constructor(private readonly resolver: LinkResolver) {}

  blocks(blocks: readonly Block[]): string {
    let out = "";
    let previousList = false;
    let previousNumbered = false;
    let number = 0;
    for (const block of blocks) {
      if (block.type === "numberedListItem") {
        const start = propNumber(block, "start");
        number = start !== null && number === 0 ? start : number + 1;
        if (number === 0) number = 1;
      } else number = 0;
      const text = this.block(block, number);
      if (!text) {
        previousList = false;
        previousNumbered = false;
        continue;
      }
      const list = LIST_TYPES.includes(block.type);
      // WP-102 (Orbit ab86dac): a numbered list that does not start at 1 cannot interrupt the line above it, so a blank
      // line is what keeps it a list rather than more of the paragraph before it.
      const startsLate = block.type === "numberedListItem" && number !== 1 && !previousNumbered;
      if (out) out += list && previousList && !startsLate ? "\n" : "\n\n";
      out += text;
      previousList = list;
      previousNumbered = block.type === "numberedListItem";
    }
    return out;
  }

  private block(block: Block, number: number): string {
    const nested = () => this.blocks(block.children);
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, propNumber(block, "level") ?? 1));
        const text = this.inline(block.content, "line").trim();
        return joinBlocks(text ? `${"#".repeat(level)} ${text}` : "", nested());
      }
      case "bulletListItem":
      case "toggleListItem":
        return this.listItem("- ", "", block);
      case "checkListItem":
        return this.listItem("- ", propBool(block, "checked") ? "[x] " : "[ ] ", block);
      case "numberedListItem":
        return this.listItem(`${number}. `, "", block);
      case "quote": {
        const body = joinBlocks(this.paragraph(block.content), nested());
        return body ? quoteText(body) : "";
      }
      case "callout": {
        const emoji = propStr(block, "emoji").trim();
        const text = this.paragraph(block.content);
        const head = !emoji ? text : !text ? emoji : `${emoji} ${text}`;
        const body = joinBlocks(head, nested());
        return body ? quoteText(body) : "";
      }
      case "codeBlock": {
        const code = plainText(block.content);
        let language = [...propStr(block, "language")].filter((character) => !/\s/.test(character) && character !== "`").join("");
        if (language === "text") language = "";
        const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
        const fenced = code ? `${fence}${language}\n${code}\n${fence}` : `${fence}${language}\n${fence}`;
        return joinBlocks(fenced, nested());
      }
      case "divider":
        return joinBlocks("---", nested());
      case "table":
        return joinBlocks(this.table(block.content), nested());
      case "image":
        return this.media(block, true, nested());
      case "file":
      case "video":
      case "audio":
        return this.media(block, false, nested());
      case "page": {
        const pageId = propStr(block, "pageId");
        const link = this.resolver.page(pageId);
        const written = !pageId ? "" : link
          ? `[${escapeLabel(link.title.trim() || "Untitled")}](${linkDestination(link.href)})`
          : "*Missing page*";
        return joinBlocks(written, nested());
      }
      default:
        return joinBlocks(this.paragraph(block.content), nested());
    }
  }

  private media(block: Block, image: boolean, nested: string): string {
    const url = propStr(block, "url");
    const caption = propStr(block, "caption").trim();
    if (!url) return joinBlocks("", nested);
    const name = propStr(block, "name").trim();
    const destination = linkDestination(this.resolver.url(url));
    let written: string;
    if (image) {
      const alt = name || caption;
      written = `![${escapeLabel(alt)}](${destination})`;
    } else {
      const label = name || url.split("/").filter(Boolean).pop() || "File";
      written = `[${escapeLabel(label)}](${destination})`;
    }
    const captionLine = caption ? `*${escapeText(caption, false)}*` : "";
    return joinBlocks(joinBlocks(written, captionLine), nested);
  }

  private listItem(marker: string, mark: string, block: Block): string {
    const text = this.inline(block.content, "block");
    let head = `${mark}${text}`;
    if (head) {
      head = head
        .split("\n")
        .map((line, index) => (index === 0 && mark ? line : escapeLineStart(line)))
        .join("\n");
    }
    const nested = this.blocks(block.children);
    // WP-102 (Orbit ab86dac): only a bullet list, or a numbered list that starts at 1, can follow the item's own line as
    // part of the same item. Anything else, a child paragraph, quote or heading, or a numbered list past 1, needs a blank
    // line or Markdown reads it as more of the item's paragraph and it is lost on the way back in.
    const follows = nested ? continuesItem(nested.split("\n")[0] ?? "") : false;
    const body = !nested ? head : !head ? `\n${nested}` : follows ? `${head}\n${nested}` : `${head}\n\n${nested}`;
    return indentText(body, marker, " ".repeat(marker.length)).trimEnd();
  }

  private paragraph(content: Block["content"]): string {
    const text = this.inline(content, "block");
    if (!text.trim()) return "";
    return text.split("\n").map(escapeLineStart).join("\n");
  }

  private inline(content: unknown, mode: Mode): string {
    const items: Array<{ kind: "text"; text: string; styles: StyleFlags } | { kind: "link"; href: string; label: Array<[string, StyleFlags]> }> = [];
    const values = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
    for (const value of values) {
      if (typeof value === "string") items.push({ kind: "text", text: value, styles: EMPTY_STYLES });
      else if (value && typeof value === "object" && "type" in value && value.type === "mention") {
        items.push({ kind: "text", text: `@${this.mentionToken(value as Inline)}`, styles: EMPTY_STYLES });
      } else if (value && typeof value === "object" && "type" in value && value.type === "link") {
        const href = "href" in value && typeof value.href === "string" ? value.href : "";
        items.push({ kind: "link", href, label: textRuns("content" in value ? value.content : undefined) });
      } else if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
        items.push({ kind: "text", text: value.text, styles: styleFlags("styles" in value ? value.styles : undefined) });
      }
    }
    let out = "";
    const runs: Array<[string, StyleFlags]> = [];
    for (const item of items) {
      if (item.kind === "text") pushRun(runs, item.text, item.styles);
      else {
        out += runsMarkdown(runs, mode);
        runs.length = 0;
        out += this.link(item.href, item.label, mode);
      }
    }
    return out + runsMarkdown(runs, mode);
  }

  /** Hivra mentions round-trip as `@kind/id`. An Orbit user mention stays `@name`. */
  private mentionToken(mention: Inline): string {
    if (mention.type !== "mention") return "Unknown user";
    const { kind, targetId, name } = mention.props;
    if (kind && targetId) return `${kind}/${targetId}`;
    const current = targetId ? this.resolver.mentionName?.(targetId) : undefined;
    const stored = (current || name || "").trim();
    return stored || "Unknown user";
  }

  private link(href: string, label: Array<[string, StyleFlags]>, mode: Mode): string {
    let labelText = runsMarkdown(label, mode === "cell" ? "cell" : "line");
    if (!href.trim()) return labelText;
    let destination = linkDestination(this.resolver.url(href));
    if (!labelText.trim()) labelText = escapeText(href, mode === "cell");
    if (mode === "cell") destination = destination.replace(/\|/g, "%7C");
    return `[${labelText}](${destination})`;
  }

  private table(content: Block["content"]): string {
    if (!content || Array.isArray(content) || !("rows" in content)) return "";
    const raw = content.rows;
    if (!Array.isArray(raw) || raw.length === 0) return "";
    const rows = raw.filter((row): row is { cells?: unknown } => !!row && typeof row === "object");
    const table = rows.map((row) => {
      const cells = Array.isArray(row.cells) ? row.cells : [];
      return cells.map((cell) => {
        const content = cell && typeof cell === "object" && "content" in cell ? cell.content : undefined;
        return this.inline(content, "cell").trim();
      });
    });
    const columns = table.reduce((max, row) => Math.max(max, row.length), 0);
    if (!columns) return "";
    const line = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? "").join(" | ")} |`;
    return [line(table[0]), `|${" --- |".repeat(columns)}`, ...table.slice(1).map(line)].join("\n");
  }
}

/** Blocks to Markdown. Empty input stays empty; anything else ends with one newline. */
export function blocksToMarkdown(blocks: readonly Block[], resolver: LinkResolver = keepLinks): string {
  const text = new Converter(resolver).blocks(blocks);
  return text ? `${text}\n` : "";
}

/** Drops ids so two conversions of the same text compare equal. */
export function stripBlockIds(blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => ({
    type: block.type,
    props: block.props,
    content: block.content,
    children: stripBlockIds(block.children),
  }));
}
