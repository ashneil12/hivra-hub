// Translated from Raven raven/utils/text.py parse_iso_ts_ms and the importer's
// truncate (Apache-2.0). The upstream files do not carry a separate copyright
// line. Licence: src/features/historyImport/vendor/raven-LICENSE.
//
// A number above 1e12 is already milliseconds; anything smaller is seconds.
// A timestamp with no timezone is UTC, matching datetime.replace(tzinfo=utc).

import { CONTENT_TRUNCATE } from "./types";

/** Parse a timestamp to Unix milliseconds. Null when it isn't one. */
export function parseIsoTsMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
  }
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let text = raw.trim();
  if (!text.includes("T") && /^\d{4}-\d{2}-\d{2} /.test(text)) {
    text = text.replace(" ", "T");
  }
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const ms = Date.parse(zoned ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Raven's content cap. The cut is marked so a reader can see it was shortened. */
export function truncateContent(text: string): string {
  if (text.length <= CONTENT_TRUNCATE) return text;
  return `${text.slice(0, CONTENT_TRUNCATE)}...`;
}

/**
 * JSONL rows. Bad lines are skipped, not fatal: Raven's reader does this
 * because a transcript still being written often ends on a torn line. Agent
 * Zero raises instead; that would throw away the rest of a real file.
 */
export function jsonLines(text: string): { rows: Record<string, unknown>[]; skipped: number } {
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rows.push(value as Record<string, unknown>);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/** Last path segment, accepting Windows separators. Empty when there isn't one. */
export function lastSegment(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}

/** Project folder: the chat's cwd, otherwise the file's parent. Never ".." . */
export function projectName(cwd: unknown, filePath: string): string {
  if (typeof cwd === "string" && cwd.trim()) {
    const fromCwd = lastSegment(cwd.trim());
    if (fromCwd && fromCwd !== "..") return fromCwd;
  }
  const parts = filePath.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (parent && parent !== "..") return parent;
  return "unknown";
}

/** A citation token. Anything else would let a model smuggle a fake source. */
export function sourceToken(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned || fallback;
}
