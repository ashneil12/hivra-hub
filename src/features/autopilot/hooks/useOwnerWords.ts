// WP-243: before a tool card waits for Ash, the app asks whether his own words already cover that exact action
// (model/ownerWords.ts). On by default (Ash agreed, 11 Nov). It only ever runs in the main window, only in a chat Ash
// talks to himself (never a delegated worker, a hidden orchestration turn, an inbox ask or a throwaway chat), and only
// when Settings > Memory has a cheap model picked: without one there is nothing to ask, so every card waits for him as
// before. An allow it makes is bound to the card's frozen action (approvalAction.ts) and the chat shows the words.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, type MutableRefObject } from "react";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Block, CoveredBy, Session } from "../../sessions/model/session";
import { checkOwnerWords, ownerMessages, type OwnerWords, type OwnerWordsAsk } from "../model/ownerWords";
import { sessionProject } from "./useAutopilot";

/** How far back from a chat's end an open card is looked for (as autopilot does). */
const LOOKBACK = 40;

export type OwnerWordsOptions = {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  updateSession: (id: string, change: (session: Session) => Session) => void;
  /** The app's one approval door; an allow names the hash it was judged on. True when it went to the CLI. */
  approve: (sessionId: string, requestId: number, decision: ApprovalDecision, actionHash?: string) => boolean;
  isDelegated: (sessionId: string) => boolean;
  /** The cheap tier's call, or undefined when no cheap model is picked (tests pass their own). */
  ask?: () => OwnerWordsAsk | undefined;
  /** Ash's standing answers for a project (tests pass their own). */
  rules?: (project: string | null) => Promise<string[]>;
  /** A routine's instructions, for a chat that is a routine's run (tests pass their own). */
  routine?: (automationId: string) => Promise<string | undefined>;
};

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** A chat whose user turns are Ash's own: not a worker, a hidden turn's chat, an inbox ask or a throwaway one. */
export function ownerChat(session: Session, delegated: boolean): boolean {
  if (session.worktreeRemoved || session.ephemeral || session.inboxAsk || session.orchestrationLeadId) return false;
  if (delegated) return false;
  // A hidden chat counts only as a routine's run, whose instructions are the routine's.
  if (session.sidebarHidden && !session.automationId) return false;
  return true;
}

function openCards(session: Session): Block[] {
  const out: Block[] = [];
  const start = Math.max(0, session.blocks.length - LOOKBACK);
  for (let i = session.blocks.length - 1; i >= start; i--) {
    const block = session.blocks[i];
    if (block.approval && !block.approval.decided && block.approval.actionHash) out.push(block);
  }
  return out;
}

/** Mark the card that was allowed with the words that covered it. */
export function withCoveredBy(session: Session, requestId: number, hash: string, by: CoveredBy): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.approval && block.approval.requestId === requestId && block.approval.actionHash === hash
        ? { ...block, approval: { ...block.approval, coveredBy: by } }
        : block,
    ),
  };
}

async function realAsk(): Promise<OwnerWordsAsk | undefined> {
  const [{ loadMemoryTier }, { realCall, routeFor }] = await Promise.all([
    import("../../memory/model/tier"),
    import("../../memory/model/cheapAsk"),
  ]);
  const choice = loadMemoryTier();
  if (choice.tier !== "cheap" || !choice.model) return undefined;
  const route = routeFor(choice.model);
  if (!route) return undefined;
  return async (prompt) => {
    const outcome = await realCall(route, prompt);
    return { ok: !!outcome?.ok, text: typeof outcome?.text === "string" ? outcome.text : undefined };
  };
}

async function realRules(project: string | null): Promise<string[]> {
  if (!project) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const rows = await invoke<Array<{ answer?: unknown }>>("decisions_standing_list", { project });
  return Array.isArray(rows)
    ? rows.map((row) => (typeof row?.answer === "string" ? row.answer.trim() : "")).filter(Boolean)
    : [];
}

async function realRoutine(automationId: string): Promise<string | undefined> {
  const { listAutomations } = await import("../../automations/model/automations");
  const found = (await listAutomations()).find((automation) => automation.id === automationId);
  return typeof found?.prompt === "string" && found.prompt.trim() ? found.prompt : undefined;
}

/** One pass over the chats: every open card not yet judged is checked once. Exported for tests. */
export async function judgeOpenCards(
  options: OwnerWordsOptions,
  handled: Set<string>,
  ask: OwnerWordsAsk | undefined,
): Promise<void> {
  if (!ask) return;
  for (const session of options.sessions) {
    if (!ownerChat(session, options.isDelegated(session.id))) continue;
    for (const block of openCards(session)) {
      const approval = block.approval!;
      const key = `${session.id}:${approval.requestId}:${approval.actionHash}`;
      if (handled.has(key)) continue;
      handled.add(key);
      const words: OwnerWords = {
        messages: ownerMessages(session.blocks),
        rules: await (options.rules ?? realRules)(sessionProject(session)).catch(() => []),
        routine: session.automationId
          ? await (options.routine ?? realRoutine)(session.automationId).catch(() => undefined)
          : undefined,
      };
      const verdict = await checkOwnerWords({ block, folder: session.worktreeCwd || session.cwd, words, ask });
      if (verdict.kind !== "covered") continue;
      // Still the same card, still open: then allow it, bound to its hash, and say why.
      const now = options.sessionsRef.current.find((s) => s.id === session.id);
      const still = now?.blocks.some(
        (b) => b.approval?.requestId === approval.requestId && b.approval.actionHash === approval.actionHash && !b.approval.decided,
      );
      if (!still) continue;
      options.updateSession(session.id, (s) => withCoveredBy(s, approval.requestId, approval.actionHash!, verdict.by));
      const sent = options.approve(session.id, approval.requestId, "allow", approval.actionHash);
      if (!sent)
        options.updateSession(session.id, (s) => ({
          ...s,
          blocks: s.blocks.map((b) =>
            b.approval?.requestId === approval.requestId && b.approval.actionHash === approval.actionHash && b.approval.coveredBy
              ? { ...b, approval: { ...b.approval, coveredBy: undefined } }
              : b,
          ),
        }));
    }
  }
}

export function useOwnerWords(options: OwnerWordsOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const main = useRef(isMainWindow());
  /** Cards already judged (chat, request id and hash): each is checked once. Passes may overlap; a key is taken first. */
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!main.current) return;
    const fresh = options.sessions.some((s) =>
      s.blocks.some(
        (b) => b.approval && !b.approval.decided && b.approval.actionHash && !handled.current.has(`${s.id}:${b.approval.requestId}:${b.approval.actionHash}`),
      ),
    );
    if (!fresh) return;
    void (async () => {
      try {
        const ask = latest.current.ask ? latest.current.ask() : await realAsk().catch(() => undefined);
        await judgeOpenCards({ ...latest.current, sessions: options.sessions }, handled.current, ask);
      } catch (error) {
        // A check that fails leaves the card for Ash: never an allow on an error.
        console.warn("Owner words check:", error);
      }
    })();
  }, [options.sessions]);
}
