// WP-51: after a first mate's turn, one unreviewed fact or a skill proposal. The main window only, so two windows
// don't both ask. A failed ask leaves the turn unfinished, and the save is compare-and-swap.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { codingTeamChatProject } from "../../features/hub/model/codingTeam";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import { collectAnswer, settleTurn, type CuratorAsk, type CuratorContext } from "../../features/memory/model/curator";
import { cheapAsk, cheapProblem } from "../../features/memory/model/cheapAsk";
import { askCrew } from "../../features/memory/model/crewBrief";
import { parseDoc, type MemoryDoc } from "../../features/memory/model/doc";
import { markLived } from "../../features/memory/model/fade";
import { noteDeferred, noteOutcome } from "../../features/memory/model/health";
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

export function useMemoryCurator(sessions: readonly Session[], enabled: boolean): void {
  const on = enabled && isMainWindow();
  const fedLast = useRef(new Map<string, string | undefined>());
  const countedDeferrals = useRef(new Set<string>());
  const attempts = useRef(new Map<string, number>());
  useEffect(() => {
    if (!on) return;
    for (const feed of curatorFeeds(sessions, fedLast.current, mateForSession)) {
      // WP-100: the engine whose chat this turn ran in, so a memory one engine wrote is labelled for another.
      const engine = sessions.find((session) => session.id === feed.sessionId)?.harness;
      const ctx: CuratorContext = {
        mateId: feed.mateId,
        turnId: feed.turnId,
        user: feed.user,
        assistant: feed.assistant,
        now: Date.now(),
        ...(engine ? { by: engine } : {}),
      };
      void (async () => {
        let loaded: MemoryDoc;
        try {
          loaded = await loadDoc();
        } catch {
          fedLast.current.delete(feed.sessionId);
          return;
        }
        // WP-103: the tier is read here, once per turn: a change lands on the next turn, never on a past one. The turn
        // carries it from here, so the memory written says which tier wrote it.
        const choice = loadMemoryTier();
        const tierCtx: CuratorContext = { ...ctx, via: choice.tier };
        // The budget is taken inside the ask, just before the real call, so a turn that never reaches a model
        // (already done, a secret, empty) spends nothing.
        const turnKey = `${ctx.mateId}:${ctx.turnId}`;
        let paused = false;
        const guarded = budgetedAsk(choice.tier, choice.model, curatorAsk(choice.tier, tierCtx, choice.model), () => {
          paused = true;
        });
        const result = await collectAnswer(loaded, tierCtx, guarded);
        if (paused) {
          fedLast.current.delete(feed.sessionId);
          return;
        }
        if (result.kind === "deferred") {
          // WP-103: the card should say a model failed to answer, not stay silent about it. The turn is not done, so
          // the next turn tries it again; the count moves on its first failure only.
          if (firstDeferral(countedDeferrals.current, turnKey)) {
            const at = Date.now();
            try {
              await commitDoc(loadDoc, saveDoc, (doc) => noteDeferred(markLived(doc, at), at));
            } catch {
              // The count is a nicety: not being able to write it never holds the turn back.
            }
          }
          // At most MAX_TRIES asks a turn: after that it is left alone, so a model that never answers cannot burn
          // the budget for every other chat.
          if (mayTryAgain(attempts.current, turnKey)) fedLast.current.delete(feed.sessionId);
          return;
        }
        try {
          // WP-100: a turn the curator saw is a day the app lived, which memory fades over, and a count for the
          // Memory screen's health card.
          await commitDoc(loadDoc, saveDoc, (doc) => {
            const settled = settleTurn(markLived(doc, tierCtx.now), tierCtx, result);
            return noteOutcome(settled.doc, settled.outcome, tierCtx.now);
          });
        } catch {
          fedLast.current.delete(feed.sessionId);
        }
      })();
    }
  }, [sessions, on]);
}
