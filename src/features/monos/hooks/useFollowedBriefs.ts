// The watcher for followed briefs (monos/model/followedBriefs.ts): briefs queued behind or steered into a busy chat,
// and leadership briefs to a project Lead's long-running chat. On every change to the chats (and every few seconds while
// any is open) it decides each open one: still waiting, settled (its report goes to the sender through the H2
// report-back path, once), or cancelled (taken out of the queue, its chat gone). A Lead's report, once its owner has
// had its turn on it, also lands in the project's Leadership room (hub/model/roomReports.ts). A chat that says the job
// is done while work it delegated still runs gets a "Still running: N" note (model/leadFlow.ts).
import { useEffect, useRef, type MutableRefObject } from "react";
import { getSession } from "../../sessions/data/sessionStore";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import {
  isOpenDelegation,
  tauriDelegations,
  type Delegation,
  type DelegationTracker,
  type DelegationsBackend,
} from "../model/delegations";
import { answeredReport, currentLeadBrief, followStep } from "../model/followedBriefs";
import { stillRunningNote } from "../model/leadFlow";
import { statusReply, statusReplyChange } from "../model/statusReply";
import { progressNote, workerLineOf } from "../model/progressNote";
import { mismatchFixNudge } from "../model/mismatchFixNudge";
import { staleTestClaimNudge } from "../model/staleTestClaim";
import { hubTestNote, hubTestRunDue, projectTestNote, runProjectTests } from "../model/projectTestRun";
import { promiseNudge } from "../model/promiseNudge";
import { joinNudges, notStartedNote, standingRuleNudge, workerStartNudge } from "../model/workerStartNudge";
import { newAgentNoteBlocks } from "../model/agentNotes";
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
  /**
   * Put an app request in a Lead's queue: its report on a brief, asked for on its own when a message steered into its
   * last turn on it mixed that turn's reply (followedBriefs.ts `reportRequest`). Without it the turn's last words go.
   */
  ask?: (chatId: string, message: QueuedMessage) => Promise<unknown> | void;
  /**
   * Add a note to a chat (leadFlow.ts `stillRunningNote`): it said the job is done while work it delegated still runs.
   * A note is never added twice (its id is the tasks it names).
   */
  note?: (chatId: string, block: Block) => void;
  /** r80: put new words in a note already in a chat (the status line, as workers report back). */
  renote?: (chatId: string, block: Block) => void;
  /** r80: take a note out of a chat (the status line, once the chat's own reply lands). */
  unnote?: (chatId: string, blockId: string) => void;
  /**
   * r78: the chats that hand out work on Ash's lists (a project Lead, a coding-team chat). One whose turn listed his asks
   * and said work starts, with no worker started, gets one app message through `ask` to start them (workerStartNudge.ts).
   */
  startsWorkers?: (chatId: string) => boolean;
  backend?: DelegationsBackend;
  now?: () => number;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const running = useRef(false);
  const again = useRef(false);
  const reported = useRef(new Set<string>());
  const asked = useRef(new Map<string, number>());
  const noted = useRef(new Set<string>());
  const nudged = useRef(new Set<string>());
  const fixNudged = useRef(new Set<string>());
  const ruleNudged = useRef(new Set<string>());
  const promiseNudged = useRef(new Set<string>());
  // Agent-to-agent notes (model/agentNotes.ts): moves from this run on, each once; which worker chats exist, once each.
  const notesSince = useRef<number | undefined>(undefined);
  const chatThere = useRef(new Map<string, boolean>());

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
      let step = followStep(row, { chat, children: [], now, asked: asked.current });
      // A Lead's brief also waits for every worker it started for it: read its tree only when that is all left.
      if ((step.kind === "settle" || step.kind === "ask") && row.follow === "lead") {
        const tree = await backend.tree(row.id).catch(() => null);
        if (!tree) continue;
        step = followStep(row, { chat, children: tree, now, asked: asked.current });
      }
      if (step.kind === "ask") {
        // Once per brief in this window; with nobody to ask, the turn's last words settle it after the grace period.
        asked.current.set(step.request.id, now);
        const ask = latest.current.ask;
        if (ask) await Promise.resolve(ask(row.childSession, step.request)).catch(() => undefined);
      } else if (step.kind === "settle") await tracker.settleFollowed(row, step.result).catch(() => false);
      else if (step.kind === "cancel") await tracker.cancelFollowed(row, step.reason).catch(() => undefined);
    }
    const note = latest.current.note;
    if (note) {
      const known = tracker.known();
      for (const owner of new Set(known.filter(isOpenDelegation).map((row) => row.ownerSession))) {
        const chat = sessionsRef.current.find((s) => s.id === owner);
        if (!chat) continue;
        const block = stillRunningNote(chat, known, currentLeadBrief(known, chat));
        // Also once per window: the chat's loaded blocks are only its latest turns.
        if (!block || noted.current.has(block.id)) continue;
        noted.current.add(block.id);
        note(owner, block);
      }
      // Who messaged whom, who got stuck, who reported: a small note in the owner's chat, linking the worker's chat
      // when it exists (none: plain text). Only this run's moves; a chat's older history isn't replayed.
      notesSince.current ??= now;
      for (const row of known) {
        const id = row.childSession;
        if (sessionsRef.current.some((s) => s.id === id)) chatThere.current.set(id, true);
        else if (!chatThere.current.has(id)) chatThere.current.set(id, !!(await getSession(id).catch(() => null)));
      }
      const exists = (id: string) => chatThere.current.get(id) ?? sessionsRef.current.some((s) => s.id === id);
      for (const { chatId, block } of newAgentNoteBlocks(known, sessionsRef.current, notesSince.current, now, exists, noted.current)) {
        noted.current.add(block.id);
        note(chatId, block);
      }
      // r78: Ash asks a busy Lead or coding-team chat how it's going: a line from the app at once (statusReply.ts).
      const startsWorkers = latest.current.startsWorkers;
      if (startsWorkers)
        for (const chat of sessionsRef.current) {
          if (!startsWorkers(chat.id)) continue;
          // r80: a line already there follows the workers, and goes once the chat's own reply lands.
          const change = statusReplyChange(chat, known, notesSince.current, now);
          if (change && "remove" in change) latest.current.unnote?.(chat.id, change.remove);
          else if (change) latest.current.renote?.(chat.id, change.update);
          // r101 (5): work out for ~10 quiet minutes and something moved: one grey line ("Still working: 2 of 5 jobs done.").
          const progress = progressNote(chat, known, now, (child) => workerLineOf(sessionsRef.current.find((s) => s.id === child)));
          if (progress) {
            noted.current.add(progress.id);
            note(chat.id, progress);
          }
          // r86: its own test run in the project, after the workers' reports, is the newer word on the suite.
          const tests = projectTestNote(chat, noted.current, now);
          if (tests) {
            noted.current.add(tests.id);
            note(chat.id, tests);
          }
          // r88 (Ash, step 4): the Lead rolled up without running the tests in the project: the app runs them itself.
          const due = hubTestRunDue(chat, known, noted.current);
          if (due) {
            noted.current.add(due.key);
            void runProjectTests(due.project).then((run) => {
              if (run) latest.current.note?.(chat.id, hubTestNote(due.key, run, chat));
            });
          }
          if (!chat.busy) continue;
          const block = statusReply(chat, known, noted.current, notesSince.current, now);
          if (!block) continue;
          noted.current.add(block.id);
          note(chat.id, block);
        }
    }
    const { startsWorkers, ask } = latest.current;
    if (startsWorkers && ask) {
      const known = tracker.known();
      for (const chat of sessionsRef.current) {
        if (!startsWorkers(chat.id)) continue;
        // r81 (P9): a standing rule in Ash's message is saved at handout, not minutes later.
        const save = standingRuleNudge(chat, ruleNudged.current);
        if (save) ruleNudged.current.add(save.id.replace(/^save-rule-/, ""));
        const start = workerStartNudge(chat, known, nudged.current);
        if (start) {
          nudged.current.add(start.id.replace(/^start-workers-/, ""));
          // r81: its "workers start now" doesn't stand uncorrected while the app asks it to start them.
          latest.current.note?.(chat.id, notStartedNote(start));
        }
        // r84: one app message, not two turns back to back.
        const request = joinNudges(save, start);
        if (request) {
          await Promise.resolve(ask(chat.id, request)).catch(() => undefined);
          continue;
        }
        // r92 (c02 0176): a test it calls still red after a newer green worker result is corrected first.
        const stale = staleTestClaimNudge(chat, fixNudged.current);
        if (stale) {
          fixNudged.current.add(stale.id.replace(/^latest-result-/, ""));
          await Promise.resolve(ask(chat.id, stale)).catch(() => undefined);
          continue;
        }
        // r85: a mismatch it flagged gets a worker or a Needs Ash line, not just a mention.
        const fix = mismatchFixNudge(chat, fixNudged.current);
        if (fix) {
          fixNudged.current.add(fix.id.replace(/^fix-mismatch-/, ""));
          await Promise.resolve(ask(chat.id, fix)).catch(() => undefined);
          continue;
        }
        // A turn that ended on "I'll do X now" with nothing after it: one app message to do it, at most twice in a row.
        const keep = promiseNudge(chat, promiseNudged.current);
        if (keep) {
          promiseNudged.current.add(keep.id.replace(/^keep-promise-/, ""));
          await Promise.resolve(ask(chat.id, keep)).catch(() => undefined);
        }
      }
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
