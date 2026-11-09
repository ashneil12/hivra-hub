// WP-135: the lines the compare view shows. One winner, no merge.
import { HARNESS_TITLE, type HarnessId } from "./session";
import { worktreeNote, type CompareRecord, type FanOutChild, type FanOutCleanup } from "./fanOut";
import { fanOutWinnerStays } from "./fanOutDecide";

export type FanOutExcerptBlock = { role?: string; text?: string; internal?: boolean };

export type FanOutCompareSession = {
  id: string;
  harness?: HarnessId;
  model?: string;
  busy?: boolean;
  worktreeRemoved?: boolean;
  blocks?: readonly FanOutExcerptBlock[];
};

export type FanOutCompareRow = {
  id: string;
  label: string;
  status: string;
  excerpt: string;
  worktree: string;
  winner: boolean;
  discarded: boolean;
  winnerLine: string | null;
  cleanupLine: string | null;
};

export function fanOutChildStatus(input: { busy?: boolean; worktreeRemoved?: boolean } | null): string {
  if (input?.worktreeRemoved) return "Worktree removed";
  if (input?.busy) return "Working";
  return "Idle";
}

/** The last reply a person would read. A missing reply is not an error. */
export function fanOutLastMessage(blocks: readonly FanOutExcerptBlock[] | undefined): string {
  if (!blocks) return "No reply yet";
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block || block.internal || block.role !== "assistant") continue;
    const text = typeof block.text === "string" ? block.text.trim().replace(/\s+/g, " ") : "";
    if (!text) continue;
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  }
  return "No reply yet";
}

function cleanupLine(state: FanOutCleanup | undefined, discarded: boolean): string | null {
  if (!discarded) return null;
  if (state === "removed") return "Its worktree was removed.";
  if (state === "kept") return "Clean-up kept this worktree.";
  if (state === "none") return "This chat had no worktree to remove.";
  if (state === "blocked") return "That worktree was not removed. Its path is outside the worktree folder.";
  return "Clean-up has not finished.";
}

function rowLabel(child: FanOutChild, session: FanOutCompareSession | undefined): string {
  const provider = session?.harness ?? child.provider;
  const model = session?.model?.trim() || child.model;
  return `${HARNESS_TITLE[provider]}: ${model}`;
}

export function fanOutCompareRows(
  record: CompareRecord,
  sessions: readonly FanOutCompareSession[],
): FanOutCompareRow[] {
  return record.children.map((child) => {
    const session = sessions.find((item) => item.id === child.id);
    const discarded = record.discardedIds.includes(child.id);
    const winner = record.winnerId === child.id;
    return {
      id: child.id,
      label: rowLabel(child, session),
      status: fanOutChildStatus(session ?? null),
      excerpt: fanOutLastMessage(session?.blocks),
      worktree: worktreeNote(child.worktree),
      winner,
      discarded,
      winnerLine: winner ? fanOutWinnerStays(child.worktree) : null,
      cleanupLine: cleanupLine(record.cleanup?.[child.id], discarded),
    };
  });
}
