// Dropwave (Ash, 11 Nov): a row in the Inbox opens its own card: what was asked, by whom, the answers, the way to the
// chat it came from and a box to reply there. This says where that chat is.
import type { HomeOpenTarget } from "../../home/model/opener";
import { needTarget } from "../../home/model/needTarget";
import type { NeedsItem, NeedsKind } from "./needsYou";

export const NEED_KIND_LABEL: Readonly<Record<NeedsKind, string>> = {
  stopped: "Stopped",
  question: "Question",
  approval: "Approval",
  merge: "Ready to merge",
  review: "Review",
  check: "Check",
};

/** A first mate as this needs: its main chat and its own chat in each project. */
export type NeedMono = { sessionId?: string; projectSessions?: Readonly<Record<string, string>> };

/**
 * The chat to reply in: the chat the ask came from, else the asking first mate's chat for that project (the Chief of
 * Staff has one per project), else its main chat. None when nobody's chat is behind the row (a page asking for access).
 */
export function needChatId(item: Pick<NeedsItem, "open" | "monoId" | "projectId">, mono: (id: string) => NeedMono | undefined): string | undefined {
  if (item.open?.where === "chat" && item.open.id.trim()) return item.open.id;
  const asker = item.monoId ? mono(item.monoId) : undefined;
  if (!asker) return undefined;
  return (item.projectId ? asker.projectSessions?.[item.projectId] : undefined) ?? asker.sessionId;
}

/** Where the card's "Open" button leads, and its words. None for a decision that lives only in the Inbox. */
export function needPlace(item: NeedsItem): { label: string; target: HomeOpenTarget } | undefined {
  const target = needTarget(item);
  if (target.kind === "chat") return { label: "Open chat", target };
  if (target.kind === "page") return { label: "Open the page", target };
  if (target.kind === "task") return { label: "Open", target };
  return undefined;
}

/** "12 min ago", "3 h ago", "2 d ago"; "just now" under a minute. */
export function askedAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The row whose card is open: the one picked while it still needs an answer, else the first when only asks show. */
export function shownNeed<T extends { key: string }>(ordered: readonly T[], picked: string | null | undefined, firstWhenNone: boolean): T | undefined {
  return ordered.find((item) => item.key === picked) ?? (firstWhenNone ? ordered[0] : undefined);
}
