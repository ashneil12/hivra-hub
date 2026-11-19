// Hivra WP-15: one compact line per brief, counted from derive_status only.

import { knownStatus, statusWord } from "./words";
import { workersUnder } from "./rows";
import type { FirstMateStatus } from "../../monos/model/delegations";

const ORDER: readonly FirstMateStatus[] = ["working", "needs-you", "done", "failed", "paused"];

function titleOf(value: string): string {
  const line = value.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
  return line.slice(0, 120) || "This brief";
}

/** "Fix the save bug: 2 working, 1 needs you". Zeros are left out. No status, no invented word. */
export function briefLine(title: string, workers: readonly { status?: unknown }[]): string {
  const counts = new Map<FirstMateStatus, number>();
  for (const worker of workers) {
    const status = knownStatus(worker.status);
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [`${count} ${statusWord(status)}`] : [];
  });
  const name = titleOf(title);
  return parts.length ? `${name}: ${parts.join(", ")}` : name;
}

type BriefSource = {
  id: string;
  ownerSession?: string | null;
  follow?: string | null;
  title?: string | null;
  parentId?: string | null;
  status?: unknown;
  state?: unknown;
  createdAt?: number;
};

/** One line per brief this chat owns, including one whose workers are all done or all paused. */
export function crewBriefLines(
  ownerSession: string,
  rows: readonly BriefSource[],
): { id: string; text: string }[] {
  const owner = ownerSession.trim();
  if (!owner) return [];
  const unique = new Map<string, BriefSource>();
  for (const row of rows) {
    if (!row?.id || row.ownerSession !== owner || row.follow !== "lead" || row.state === "cancelled") continue;
    if (!unique.has(row.id)) unique.set(row.id, row);
  }
  return [...unique.values()]
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
    .map((brief) => ({
      id: brief.id,
      text: briefLine(brief.title ?? "", workersUnder(brief.id, rows)),
    }));
}
