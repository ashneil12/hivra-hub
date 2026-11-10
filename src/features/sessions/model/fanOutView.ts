// WP-135: the lines the compare view shows. One winner, no merge.
import { formatUsd } from "../../usage/model/history";
import { HARNESS_TITLE, type HarnessId } from "./session";
import { worktreeNote, type CompareRecord, type FanOutChild, type FanOutCleanup } from "./fanOut";
import { fanOutWinnerStays } from "./fanOutDecide";

/** The token and price fields a finished turn carries, as the engine reported them. */
export type FanOutTurnMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

export type FanOutExcerptBlock = {
  role?: string;
  text?: string;
  internal?: boolean;
  turnMetrics?: FanOutTurnMetrics;
};

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
  /** What this chat has spent, from the prices its engine reported. Never estimated. */
  spend: string;
  winner: boolean;
  discarded: boolean;
  /** Discard can be pressed: not the winner, and not a discard that already finished. A pending one can be tried again. */
  canDiscard: boolean;
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

function usable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What one chat spent. Only a price the engine reported is added up; a turn with token counts and no price is
 * counted as such, and nothing is worked out from a price table.
 */
export function fanOutChildSpend(blocks: readonly FanOutExcerptBlock[] | undefined): string {
  let spent = 0;
  let priced = 0;
  let unpriced = 0;
  for (const block of blocks ?? []) {
    const metrics = block?.turnMetrics;
    if (!metrics) continue;
    const cost = usable(metrics.costUsd);
    if (cost != null) {
      spent += cost;
      priced += 1;
      continue;
    }
    const counted = [
      metrics.inputTokens,
      metrics.outputTokens,
      metrics.cacheReadTokens,
      metrics.cacheWriteTokens,
    ].some((value) => usable(value) != null);
    if (counted) unpriced += 1;
  }
  if (priced === 0) {
    return unpriced > 0 ? "Spent: no price reported" : "Spent: nothing reported yet";
  }
  const note = unpriced > 0 ? ` (${unpriced} ${unpriced === 1 ? "turn" : "turns"} had no price)` : "";
  return `Spent ${formatUsd(spent)}${note}`;
}

/**
 * One line for each model that was asked for and did not start, and one for worktrees made for the compare that
 * could not be given back, so a worktree left on disk is never a surprise.
 */
export function fanOutNotStartedLines(record: CompareRecord): string[] {
  const lines = (record.notStarted ?? []).map(
    (target) =>
      `${HARNESS_TITLE[target.provider]}: ${target.model} did not start. No own worktree could be made for it.`,
  );
  const left = record.leftBehind ?? 0;
  if (left > 0) {
    lines.push(
      left === 1
        ? "One worktree made for this compare could not be removed and was left in place. Remove it in Settings, under Worktrees."
        : `${left} worktrees made for this compare could not be removed and were left in place. Remove them in Settings, under Worktrees.`,
    );
  }
  return lines;
}

function cleanupLine(state: FanOutCleanup | undefined, discarded: boolean): string | null {
  if (!discarded) return null;
  if (state === "removed") return "Its worktree was removed.";
  if (state === "kept") {
    return "Its worktree has changes or commits of its own, so it was kept. Remove it in Settings, under Worktrees, when you are done with it.";
  }
  if (state === "none") return "This chat had no worktree to remove.";
  if (state === "blocked") return "That worktree was not removed. Its path is outside the worktree folder.";
  return "Clean-up has not finished. Press Discard to try again.";
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
      spend: fanOutChildSpend(session?.blocks),
      winner,
      discarded,
      canDiscard:
        !winner && (!discarded || (record.cleanup?.[child.id] ?? "pending") === "pending"),
      winnerLine: winner ? fanOutWinnerStays(child.worktree) : null,
      cleanupLine: cleanupLine(record.cleanup?.[child.id], discarded),
    };
  });
}
