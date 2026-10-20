// The watcher for followed briefs (monos/model/followedBriefs.ts): briefs queued behind or steered into a busy chat,
// and leadership briefs to a project Lead's long-running chat. On every change to the chats (and every few seconds while
// any is open) it decides each open one: still waiting, settled (its report goes to the sender through the H2
// report-back path, once), or cancelled (taken out of the queue, its chat gone). A Lead's report, once its owner has
// had its turn on it, also lands in the project's Leadership room (hub/model/roomReports.ts).
import { useEffect, useRef, type MutableRefObject } from "react";
import { getSession } from "../../sessions/data/sessionStore";
import type { Session } from "../../sessions/model/session";
import {
  tauriDelegations,
  type Delegation,
  type DelegationTracker,
  type DelegationsBackend,
} from "../model/delegations";
import { answeredReport, followStep } from "../model/followedBriefs";
import { completionReceipt } from "../model/monoSessionCompletion";

/** How often an open brief is looked at again even when no chat changed (the queue grace, a store-side move). */
const SWEEP_MS = 5_000;

export type FollowedReport = {
  row: Delegation;
  receipt: string;
  owner: Session;
  report: string;
  answer: string;
};

/**
 * Post each Lead report its owner has answered to the room, once (`reported` holds the receipts already posted). A
 * receipt is kept only after its post went through, so one that failed is tried again on the next sweep (the room
 * keeps one copy of a report by its id).
 */
export async function postAnsweredLeadReports(
  rows: readonly Delegation[],
  sessions: readonly Session[],
  reported: Set<string>,
  onLeadReport: (report: FollowedReport) => Promise<unknown> | void,
  /** Its post went through (the tracker lets the row go). */
  posted?: (row: Delegation) => void,
): Promise<void> {
  for (const row of rows) {
    if (row.follow !== "lead" || row.state === "running" || row.state === "question") continue;
    const receipt = completionReceipt(row.requestId, row.generation);
    if (reported.has(receipt)) continue;
    const owner = sessions.find((s) => s.id === row.ownerSession);
    if (!owner) continue;
    const answered = answeredReport(row, owner, receipt);
    if (!answered) continue;
    try {
      await onLeadReport({ row, receipt, owner, ...answered });
      reported.add(receipt);
      posted?.(row);
    } catch (error) {
      console.error("Could not post the Lead's report to its room; trying again on the next sweep", error);
    }
  }
}

export function useFollowedBriefs(options: {
  tracker: DelegationTracker;
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  /** A Lead's report reached its owner and the owner answered: post it to the room (once per receipt). */
  onLeadReport?: (report: FollowedReport) => Promise<unknown> | void;
  backend?: DelegationsBackend;
  now?: () => number;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);
  const again = useRef(false);
  const reported = useRef(new Set<string>());

  const sweepRef = useRef<() => Promise<void>>(async () => undefined);
  sweepRef.current = async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        await sweepOnce();
      } while (again.current);
    } finally {
      running.current = false;
    }
  };
  const sweepOnce = async () => {
    const { tracker, sessionsRef } = latest.current;
    if (!tracker.isLoaded()) return;
    const backend = latest.current.backend ?? tauriDelegations;
    const now = (latest.current.now ?? Date.now)();
    const chatOf = async (id: string) =>
      sessionsRef.current.find((s) => s.id === id) ?? (await getSession(id).catch(() => null));
    for (const row of tracker.openFollowed()) {
      const chat = await chatOf(row.childSession);
      let step = followStep(row, { chat, children: [], now });
      // A Lead's brief also waits for every worker it started for it: read its tree only when that is all left.
      if (step.kind === "settle" && row.follow === "lead") {
        const tree = await backend.tree(row.id).catch(() => null);
        if (!tree) continue;
        step = followStep(row, { chat, children: tree, now });
      }
      if (step.kind === "settle") await tracker.settleFollowed(row, step.result).catch(() => false);
      else if (step.kind === "cancel") await tracker.cancelFollowed(row, step.reason).catch(() => undefined);
    }
    const onLeadReport = latest.current.onLeadReport;
    if (!onLeadReport) return;
    await postAnsweredLeadReports(tracker.known(), sessionsRef.current, reported.current, onLeadReport, (row) =>
      tracker.forget(row.id),
    );
  };

  // After a change to the chats: once, shortly after the first change (a streaming chat changes constantly, so this
  // never waits for a quiet moment).
  const scheduled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (scheduled.current !== undefined) return;
    scheduled.current = window.setTimeout(() => {
      scheduled.current = undefined;
      void sweepRef.current();
    }, 200);
  }, [options.sessions]);
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (latest.current.tracker.openFollowed().length) void sweepRef.current();
    }, SWEEP_MS);
    return () => {
      window.clearInterval(tick);
      if (scheduled.current !== undefined) window.clearTimeout(scheduled.current);
      scheduled.current = undefined;
    };
  }, [options.tracker]);
}
