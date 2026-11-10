// WP-103: one plain line saying where a memory came from: the person's own words or a chat, the date, the engine
// that wrote it and the tier that wrote it. Everything here already travels with the item. Old data simply says less,
// and an import says which project it came over from.

import { engineName, normalizeFact, type MemoryItem } from "../model/doc";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Nov", or "3 Nov 2025" when it was written in another year. */
export function memoryDate(at: number, now: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "";
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? "" : ` ${date.getFullYear()}`}`;
}

/** A quote short enough for one line. */
function quote(text: string): string {
  const line = normalizeFact(text);
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

export function memoryProvenance(item: MemoryItem, now: number): string {
  const on = memoryDate(item.createdAt, now);
  const when = on ? ` on ${on}` : "";
  if (item.source.kind === "import") return `Brought over from ${item.source.label}${when}.`;
  if (item.via === "rules") {
    const words = item.evidence.trim() ? `: '${quote(item.evidence)}'` : "";
    return `Said by you${when}${words} (written by the rules).`;
  }
  if (item.via === "cheap") return `Proposed from a chat${when} by a cheap model you picked.`;
  return `Proposed from a chat${when}${item.by ? ` by ${engineName(item.by)}` : ""}.`;
}

export function MemoryProvenance({ item, now }: { item: MemoryItem; now: number }) {
  return <p data-provenance>{memoryProvenance(item, now)}</p>;
}
