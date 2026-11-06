// WP-51: after a first mate's turn, one unreviewed fact or a skill proposal. The main window only, so two windows
// don't both ask. A failed ask leaves the turn unfinished, and the save is compare-and-swap.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { codingTeamChatProject } from "../../features/hub/model/codingTeam";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import { collectAnswer, settleTurn, type CuratorContext } from "../../features/memory/model/curator";
import { askCrew } from "../../features/memory/model/crewBrief";
import { parseDoc, type MemoryDoc } from "../../features/memory/model/doc";
import { markLived } from "../../features/memory/model/fade";
import { commitDoc } from "../../features/memory/model/review";
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
  sessions: readonly { id: string; busy?: boolean; blocks: readonly FeedBlock[] }[],
  fedLast: Map<string, string | undefined>,
  mateOf: (sessionId: string) => string | undefined,
): Array<{ mateId: string; sessionId: string; turnId: string; user: string; assistant: string }> {
  const out: Array<{ mateId: string; sessionId: string; turnId: string; user: string; assistant: string }> = [];
  for (const session of sessions) {
    if (session.busy) continue;
    const mateId = mateOf(session.id);
    if (!mateId) continue;
    const turn = lastExchange(session.blocks);
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

export function useMemoryCurator(sessions: readonly Session[], enabled: boolean): void {
  const on = enabled && isMainWindow();
  const fedLast = useRef(new Map<string, string | undefined>());
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
        const result = await collectAnswer(loaded, ctx, askModel);
        if (result.kind === "deferred") {
          fedLast.current.delete(feed.sessionId);
          return;
        }
        try {
          // WP-100: a turn the curator saw is a day the app lived, which memory fades over.
          await commitDoc(loadDoc, saveDoc, (doc) => settleTurn(markLived(doc, ctx.now), ctx, result).doc);
        } catch {
          fedLast.current.delete(feed.sessionId);
        }
      })();
    }
  }, [sessions, on]);
}
