// WP-84: a phase worker's reply is handed back to the run that started it.
// A late reply, after the wait has already ended, changes nothing.

import type { FinishResult } from "./machine";

type Waiter = {
  settle: (result: FinishResult) => void;
};

const waiters = new Map<string, Waiter>();

/** True for a phase worker's session id. A coding worker's id does not match. */
export function isPhaseSession(sessionId: string): boolean {
  return sessionId.includes("-phase-");
}

/**
 * Waits for the reply to this phase session. A second wait for the same id settles the first as unreachable,
 * so two windows cannot both take the same reply.
 */
export function waitForPhaseResult(sessionId: string, timeoutMs: number): Promise<FinishResult> {
  const previous = waiters.get(sessionId);
  if (previous) previous.settle({ unreachable: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: FinishResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (waiters.get(sessionId)?.settle === finish) waiters.delete(sessionId);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    waiters.set(sessionId, { settle: finish });
  });
}

/** Hands a reply to the run that is waiting. A reply that arrives after the wait ended is ignored. */
export function deliverPhaseResult(sessionId: string, result: FinishResult): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  waiter.settle(result);
}

/**
 * The session's ending, as a phase result. Text is the document even when the status is not completed.
 * An empty completed reply is retried. A failure with no text is not a finished phase.
 */
export function phaseFinish(status: string, text: string): FinishResult {
  if (text.trim()) return { body: text };
  if (status === "completed") return { body: "" };
  return { unreachable: true };
}
