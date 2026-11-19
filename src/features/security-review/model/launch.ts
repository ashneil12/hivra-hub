// WP-203: the app starts the reviewer's session for a security review it recorded (src-tauri/src/delivery/review.rs).
//
// The Rust gate creates the review row (owner app-security-review, running, with the brief) and holds the merge. This
// module starts the session that does the review, the same way fresh-eyes reviewers start: a new session under the row's
// own child id, submitted with the brief, managed. When it finishes, the result settles the row, and the settle writes the
// record. Nothing here writes the record itself, and nothing here is reachable from an agent's tool call.
//
// Only Claude and Codex can host a review session today; another builder's review settles failed with the reason.

import type { Delegation, DelegationsBackend } from "../../monos/model/delegations";
import { newSession, type HarnessId, type Session } from "../../sessions/model/session";

/** The owner of every review delegation (delivery/review.rs OWNER). Only the app starts them. */
export const REVIEW_OWNER = "app-security-review";
/** The request id prefix of a review (delivery/review.rs REQUEST_PREFIX). */
export const REVIEW_REQUEST_PREFIX = "security-review-";
/** How long a review may run before it is shown as stuck (delivery/review.rs STUCK_AFTER_MS). It still holds the merge. */
export const REVIEW_STUCK_AFTER_MS = 60 * 60 * 1000;

const HOSTS: Record<string, HarnessId> = { claude: "claude", codex: "codex" };

export type ReviewHooks = {
  add(session: Session): void;
  submit(
    sessionId: string,
    text: string,
    history: readonly [],
    options: {
      managed?: boolean;
      onSettled?: (outcome: { status?: string; text?: string; error?: string }) => void;
    },
  ): Promise<boolean> | boolean;
  cwd: () => string;
};

/** What a review's request id names, read back from its hex key (the Rust side writes it the same way). */
export type ReviewKey = { repo: string; number: number; head: string; reviewer: string };

export function decodeReviewKey(requestId: string): ReviewKey | null {
  if (!requestId.startsWith(REVIEW_REQUEST_PREFIX)) return null;
  const hex = requestId.slice(REVIEW_REQUEST_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  let key: string;
  try {
    key = new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
  } catch {
    return null;
  }
  const match = /^(.+)#(\d+)@([0-9a-f]{40}):(.+)$/.exec(key);
  if (!match) return null;
  return { repo: match[1]!, number: Number(match[2]), head: match[3]!, reviewer: match[4]! };
}

/** The owner's id, or a reviewer's own chat (its child id is review-<hex>): either is the app's, never a caller's. */
export function isReviewSession(id: string): boolean {
  return id === REVIEW_OWNER || /^review-[0-9a-f]+$/.test(id);
}

export function isReviewRow(row: Pick<Delegation, "ownerSession" | "requestId">): boolean {
  return row.ownerSession === REVIEW_OWNER && row.requestId.startsWith(REVIEW_REQUEST_PREFIX);
}

/**
 * Starts the reviewer's session for one running review row. Returns false when no session can run the reviewer's builder;
 * in that case the row is settled failed with the reason, so the gate says why instead of waiting.
 */
export function startReviewSession(row: Delegation, hooks: ReviewHooks, backend: DelegationsBackend): boolean {
  const key = decodeReviewKey(row.requestId);
  const harness = key ? HOSTS[key.reviewer] : undefined;
  if (!key || !harness) {
    void backend.settle({
      id: row.id,
      generation: row.generation,
      state: "failed",
      error: key ? `No session can run ${key.reviewer} for this review.` : "The review's request id is not readable.",
    });
    return false;
  }
  const session: Session = {
    ...newSession(harness, hooks.cwd()),
    id: row.childSession,
    title: `Security review of ${key.repo}#${key.number}`,
  };
  hooks.add(session);
  void hooks.submit(session.id, row.brief ?? "", [], {
    managed: true,
    onSettled: (outcome) => {
      if (outcome.status === "completed" && outcome.text) {
        void backend.settle({ id: row.id, generation: row.generation, state: "completed", result: outcome.text });
      } else {
        void backend.settle({
          id: row.id,
          generation: row.generation,
          state: "failed",
          error: outcome.error || "The reviewer's session ended without a result.",
        });
      }
    },
  });
  return true;
}

/**
 * Starts the sessions for review rows that are running and not yet started, once each. Called when the delegations change
 * and at bind time. Returns the number started.
 */
export async function startPendingReviews(
  backend: DelegationsBackend,
  hooks: ReviewHooks,
  started: Set<string>,
): Promise<number> {
  const open = await backend.listOpen();
  let count = 0;
  for (const row of open) {
    // Keyed by generation: a review reopened as a new attempt starts again.
    const key = `${row.id}:${row.generation}`;
    if (row.state !== "running" || !isReviewRow(row) || started.has(key)) continue;
    started.add(key);
    startReviewSession(row, hooks, backend);
    count += 1;
  }
  return count;
}

/** The line the Inbox and the Lead tick show for one review: running, stuck, failed or finished. */
export function reviewLine(row: Delegation, now: number): string {
  const key = decodeReviewKey(row.requestId);
  const pr = key ? `PR #${key.number}` : "the pull request";
  if (row.state === "running") {
    const since = (row as Delegation & { runStartedAt?: number }).runStartedAt ?? row.createdAt;
    if (now - since > REVIEW_STUCK_AFTER_MS) {
      return `Security review stuck for ${pr}: running longer than an hour. The merge is held.`;
    }
    return `Security review running for ${pr}.`;
  }
  if (row.state === "completed") return `Security review finished for ${pr}; its record decides the merge.`;
  return `Security review failed for ${pr}${row.error ? `: ${row.error}` : "."}`;
}
