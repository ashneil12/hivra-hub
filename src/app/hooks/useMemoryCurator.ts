// WP-51: what a first mate's chats teach memory. The main window only, so two windows don't both ask, and every save is
// compare-and-swap.
// WP-240: two paths. Right after a turn, the person's own "remember that …" is saved at once, as confirmed, with no
// model. Everything else is learned in batches (features/memory/model/batch.ts): every BATCH_EVERY_TURNS finished
// turns, after BATCH_IDLE_MS quiet, or when a chat closes. The curator no longer runs after every turn.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { codingTeamChatProject } from "../../features/hub/model/codingTeam";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import type { CuratorAsk, CuratorContext } from "../../features/memory/model/curator";
import {
  BATCH_EVERY_TURNS,
  BATCH_IDLE_MS,
  chatKey,
  planBatches,
  rememberNow,
  rulesBatchReply,
  runBatch,
  type BatchChat,
} from "../../features/memory/model/batch";
import { cheapAsk, cheapProblem } from "../../features/memory/model/cheapAsk";
import { askCrew } from "../../features/memory/model/crewBrief";
import { parseDoc, type MemoryDoc } from "../../features/memory/model/doc";
import { markLived } from "../../features/memory/model/fade";
import { noteOutcome } from "../../features/memory/model/health";
import { loadSkillMode } from "../../features/selfBuild/model/skillMode";
import { loadSensitive } from "../../features/memory/model/sensitive";

/**
 * Save before a tidy: a first mate's chat is about to move to a fresh engine session (monos/model/monoRotation.ts), so
 * its messages are read by a batch now, not at the next batch. Detail: `{ sessionId }`. The batch reads the chat, not the
 * engine session, so the turn never waits on it.
 */
export const MEMORY_BATCH_NOW_EVENT = "monocode:memory-batch-now";

/** WP-240: the one-line reply the explicit path gives, for whatever shows it. Detail: `{ sessionId, text }`. */
export const MEMORY_REMEMBERED_EVENT = "monocode:memory-remembered";
import { notePaused, takeBudget } from "../../features/memory/model/memoryBudget";
import { commitDoc } from "../../features/memory/model/review";
import { memoryReadableBlocks } from "../../features/memory/model/privateChat";
import { rulesAnswer } from "../../features/memory/model/ruleCurator";
import { loadMemoryTier, tierSendsText, type MemoryTier } from "../../features/memory/model/tier";
import type { Session } from "../../features/sessions/model/session";

type Loaded = { revision: number; doc: unknown };

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

async function loadDoc(): Promise<MemoryDoc> {
  const loaded = await invoke<Loaded>("memory_review_load");
  const doc = parseDoc(loaded.doc);
  doc.revision = typeof loaded.revision === "number" ? loaded.revision : 0;
  return doc;
}

function saveDoc(revision: number, doc: MemoryDoc): Promise<boolean> {
  return invoke<boolean>("memory_review_cas", { revision, doc });
}

/** The first mate this finished chat belongs to, or none for a worker or a room. */
export function mateForSession(sessionId: string): string | undefined {
  const mono = monoForSession(sessionId);
  if (mono?.sessionId === sessionId) return mono.id;
  const project = codingTeamChatProject(sessionId);
  if (!project) return undefined;
  const lead = findMono(`${project}-lead`);
  if (!lead || lead.longChat) return undefined;
  if (lead.sessionId && lead.sessionId !== sessionId) return undefined;
  return lead.id;
}

type FeedBlock = { id: string; role: string; text?: string; streaming?: boolean; draft?: boolean };

export function lastExchange(blocks: readonly FeedBlock[]): { turnId: string; user: string; assistant: string } | undefined {
  const finished = blocks.filter((block) => !block.streaming && !block.draft);
  for (let i = finished.length - 1; i >= 0; i--) {
    const block = finished[i];
    if (block.role !== "assistant" || !block.text?.trim()) continue;
    let user = "";
    for (let j = i - 1; j >= 0; j--) {
      if (finished[j].role === "assistant") break;
      if (finished[j].role === "user" && finished[j].text?.trim()) {
        user = finished[j].text ?? "";
        break;
      }
    }
    return { turnId: block.id, user: user.slice(0, 4000), assistant: block.text.slice(0, 4000) };
  }
  return undefined;
}

export function curatorFeeds(
  sessions: readonly { id: string; busy?: boolean; private?: boolean; privateBoundaryId?: string; blocks: readonly FeedBlock[] }[],
  fedLast: Map<string, string | undefined>,
  mateOf: (sessionId: string) => string | undefined,
): Array<{ mateId: string; sessionId: string; turnId: string; user: string; assistant: string }> {
  const out: Array<{ mateId: string; sessionId: string; turnId: string; user: string; assistant: string }> = [];
  for (const session of sessions) {
    if (session.busy) continue;
    const mateId = mateOf(session.id);
    if (!mateId) continue;
    // WP-111: a private chat is never read. After it is switched off, only messages past the boundary are.
    const turn = lastExchange(memoryReadableBlocks(session));
    if (!turn || fedLast.get(session.id) === turn.turnId) continue;
    fedLast.set(session.id, turn.turnId);
    out.push({ mateId, sessionId: session.id, ...turn });
  }
  return out;
}

// WP-51: a signed-in CLI through the crew. No key is read or stored.
function askModel(prompt: string) {
  return askCrew(prompt);
}

/**
 * WP-103: the tier the person chose. Rules answers without asking anything; cheap asks the model they picked;
 * crew is today's brief to a signed-in CLI. The tier is read once per turn, so a change starts with the next turn.
 */
export function curatorAsk(tier: MemoryTier, turn: { user: string; assistant: string }, model?: string): (prompt: string) => Promise<CuratorAsk> {
  if (tier === "rules") {
    return async () => {
      const answer = rulesAnswer(turn);
      return { ok: true, text: answer.kind === "reply" ? answer.text : "" };
    };
  }
  if (tier === "cheap") return cheapAsk(model);
  return askModel;
}

/**
 * WP-103: the background budget. Only a turn that will call a model spends it: the crew always does, the cheap tier
 * only once a model is picked (a cheap tier with no model hands back a deferral of its own, and spends nothing). A
 * turn that does not fit is left for later (the caller unfeds it, so a later turn tries again), and the pause is
 * recorded for the Memory screen's health card. A manual action on that screen never comes through here.
 */
export function backgroundAskFits(tier: MemoryTier, model: string | undefined, now: number): boolean {
  if (!tierSendsText(tier)) return true;
  if (tier === "cheap" && cheapProblem(model)) return true;
  const budget = takeBudget(now);
  if (budget.ok) return true;
  notePaused({ problem: budget.problem, until: budget.until });
  return false;
}

/**
 * WP-103: wraps an ask so the budget is taken at the moment of the real call, not before the curator's early returns
 * (already done, a secret, empty). When it does not fit, nothing is called and `onPaused` hears of it.
 */
export function budgetedAsk(
  tier: MemoryTier,
  model: string | undefined,
  ask: (prompt: string) => Promise<CuratorAsk>,
  onPaused: () => void,
  now: () => number = Date.now,
): (prompt: string) => Promise<CuratorAsk> {
  return async (prompt) => {
    if (!backgroundAskFits(tier, model, now())) {
      onPaused();
      return { ok: false, kind: "timeout", reason: "The memory spending limit is reached." };
    }
    return ask(prompt);
  };
}

/**
 * WP-103: a turn left for later is counted once on the health card, however many times it is tried again. Bounded so
 * a long session cannot grow the set without limit.
 */
export function firstDeferral(counted: Set<string>, key: string): boolean {
  if (counted.has(key)) return false;
  counted.add(key);
  if (counted.size > 500) {
    const oldest = counted.values().next().value;
    if (oldest !== undefined) counted.delete(oldest);
  }
  return true;
}

/** WP-103: a turn that fails for a reason that may pass is asked at most this many times in all. */
export const MAX_TRIES = 2;

/** Counts one failed try of a turn. True while the turn may still be asked again. Bounded like firstDeferral. */
export function mayTryAgain(tries: Map<string, number>, key: string): boolean {
  const used = (tries.get(key) ?? 0) + 1;
  tries.delete(key);
  tries.set(key, used);
  if (tries.size > 500) {
    const oldest = tries.keys().next().value;
    if (oldest !== undefined) tries.delete(oldest);
  }
  return used < MAX_TRIES;
}

/** WP-240: a chat a batch should still read: one that just closed, kept until the batch that reads it has run. */
type ClosedChat = BatchChat;

/** WP-240: the first-mate chats memory may read right now, plus any that closed since the last batch. */
export function batchChats(
  sessions: readonly { id: string; busy?: boolean; private?: boolean; privateBoundaryId?: string; sidebarHidden?: boolean; blocks: readonly FeedBlock[] }[],
  mateOf: (sessionId: string) => string | undefined,
  closed: readonly ClosedChat[] = [],
): BatchChat[] {
  const open = sessions.flatMap((session) => {
    if (session.busy) return [];
    const mateId = mateOf(session.id);
    if (!mateId) return [];
    return [{ mateId, sessionId: session.id, blocks: memoryReadableBlocks(session) }];
  });
  const seen = new Set(open.map((chat) => chat.sessionId));
  return [...open, ...closed.filter((chat) => !seen.has(chat.sessionId))];
}

/**
 * WP-240: the batch triggers. Every BATCH_EVERY_TURNS finished turns, after BATCH_IDLE_MS with none, or when a
 * first-mate chat closes (it leaves the list or is hidden), whichever comes first.
 */
export function trackChats(
  known: Map<string, BatchChat>,
  sessions: readonly { id: string; busy?: boolean; private?: boolean; privateBoundaryId?: string; sidebarHidden?: boolean; blocks: readonly FeedBlock[] }[],
  mateOf: (sessionId: string) => string | undefined,
): BatchChat[] {
  // A busy chat is still open: only one that left the list or was hidden has closed. Its last readable snapshot is
  // what the batch reads.
  const present = new Set(sessions.filter((session) => !session.sidebarHidden && mateOf(session.id)).map((session) => session.id));
  const closed = [...known.values()].filter((chat) => !present.has(chat.sessionId));
  for (const chat of closed) known.delete(chat.sessionId);
  for (const chat of batchChats(sessions, mateOf)) if (present.has(chat.sessionId)) known.set(chat.sessionId, chat);
  return closed;
}

export function useMemoryCurator(sessions: readonly Session[], enabled: boolean): void {
  const on = enabled && isMainWindow();
  const fedLast = useRef(new Map<string, string | undefined>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const turnsSince = useRef(0);
  const running = useRef(false);
  const again = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const known = useRef(new Map<string, BatchChat>());
  const closing = useRef<BatchChat[]>([]);

  const runBatches = useRef(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    turnsSince.current = 0;
    try {
      do {
        again.current = false;
        const closed = closing.current;
        closing.current = [];
        const chats = batchChats(sessionsRef.current, mateForSession, closed);
        // WP-103: the tier is read once per batch, so a change lands on the next batch, never on one half done.
        const choice = loadMemoryTier();
        let base = await loadDoc();
        const mates = planBatches(base, chats).map((plan) => plan.mateId);
        for (const mateId of mates) {
          // At most a few calls in a row for one first mate: a long backlog is read over several batches.
          for (let round = 0; round < 5; round++) {
            base = await loadDoc();
            const plan = planBatches(base, chats).find((candidate) => candidate.mateId === mateId);
            if (!plan) break;
            const now = Date.now();
            // WP-103: only a batch that will call a model spends the background budget. A batch that does not fit
            // waits; its messages stay behind the watermark, nothing is counted as failed.
            if (plan.messages.length && !backgroundAskFits(choice.tier, choice.model, now)) return;
            const engine = sessionsRef.current.find((session) => plan.messages[0] && chatKey(mateId, session.id) === plan.messages[0].chat)?.harness;
            const ask: (prompt: string) => Promise<CuratorAsk> =
              choice.tier === "rules" ? async () => ({ ok: true, text: rulesBatchReply(plan) }) : curatorAsk(choice.tier, { user: "", assistant: "" }, choice.model);
            const result = await runBatch(loadDoc, saveDoc, plan, base, ask, {
              now,
              via: choice.tier,
              skills: loadSkillMode(),
              ...(loadSensitive() ? {} : { sensitiveOff: true as const }),
              ...(engine ? { by: engine } : {}),
            });
            if (result.status !== "applied" || !plan.more) break;
          }
        }
      } while (again.current);
    } catch {
      // Memory could not be read or saved this time. The messages stay behind the watermark for the next batch.
    } finally {
      running.current = false;
    }
  });

  useEffect(() => {
    if (!on) return;
    const now = Date.now();
    // WP-240: a chat that closed is read one last time by a batch, now.
    const closed = trackChats(known.current, sessions, mateForSession);

    const feeds = curatorFeeds(sessions, fedLast.current, mateForSession);
    for (const feed of feeds) {
      const engine = sessions.find((session) => session.id === feed.sessionId)?.harness;
      const ctx: CuratorContext = {
        mateId: feed.mateId,
        turnId: feed.turnId,
        user: feed.user,
        assistant: feed.assistant,
        now,
        ...(engine ? { by: engine } : {}),
      };
      void (async () => {
        let reply: string | undefined;
        try {
          // WP-240: the explicit path. "Remember that …" is saved now, as confirmed; nothing else is asked here.
          await commitDoc(loadDoc, saveDoc, (doc) => {
            const remembered = rememberNow(markLived(doc, now), ctx);
            reply = remembered.reply;
            return remembered.outcome.status === "none" ? remembered.doc : noteOutcome(remembered.doc, remembered.outcome, now);
          });
        } catch {
          fedLast.current.delete(feed.sessionId);
          return;
        }
        if (reply && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(MEMORY_REMEMBERED_EVENT, { detail: { sessionId: feed.sessionId, text: reply } }));
        }
      })();
    }

    if (feeds.length) {
      turnsSince.current += feeds.length;
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(() => void runBatches.current(), BATCH_IDLE_MS);
    }
    if (closed.length) closing.current = [...closing.current, ...closed];
    if (closed.length || turnsSince.current >= BATCH_EVERY_TURNS) void runBatches.current();
  }, [sessions, on]);

  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const batchNow = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
      const mateId = session ? mateForSession(session.id) : undefined;
      if (!session || !mateId) return;
      // The chat is busy with the turn that tidied it, so it is handed over as a snapshot, the way a closed chat is.
      closing.current = [...closing.current.filter((chat) => chat.sessionId !== session.id), { mateId, sessionId: session.id, blocks: memoryReadableBlocks(session) }];
      void runBatches.current();
    };
    window.addEventListener(MEMORY_BATCH_NOW_EVENT, batchNow);
    return () => window.removeEventListener(MEMORY_BATCH_NOW_EVENT, batchNow);
  }, [on]);

  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );
}
