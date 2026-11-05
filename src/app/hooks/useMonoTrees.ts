// Long chats (monos/model/monoTreeStore.ts, "Keep one long chat"): each finished turn of a long-chat Mono's own chat
// goes into its summary tree, from the blocks the chat already keeps. In the Hub bundle's main window only, so two
// windows never write one tree. The summaries run on the hub's cheap isolated call (the same one the dump check
// uses), in the background; nothing here waits on them or holds a turn.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import type { Session } from "../../features/sessions/model/session";
import { codingTeamChatProject } from "../../features/hub/model/codingTeam";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import { feedTree, setTreeCompactor } from "../../features/monos/model/monoTreeStore";
import { chatBytes, LONG_CHAT_THRESHOLD } from "../../features/memory/model/longChat";
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../../integrations/harness";
import { homeDir } from "../../platform/tauri/fs";

const COMPACTION_TIMEOUT_MS = 180_000;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** One compaction: an isolated text prompt on the runtime's own model, no tools (plan intent). */
export async function isolatedCompaction(prompt: string): Promise<string> {
  if (!canRunHarnessTextPrompt("claude")) throw new Error("No engine for the long chat's summaries");
  return runHarnessTextPrompt({ harness: "claude", cwd: await homeDir(), prompt, intent: "plan", timeoutMs: COMPACTION_TIMEOUT_MS });
}

/** A coding-team chat uses the lead's tree only while the lead has no chat of its own. */
export function leadForThreshold(sessionId: string): string | undefined {
  const project = codingTeamChatProject(sessionId);
  if (!project) return undefined;
  const lead = findMono(`${project}-lead`);
  if (!lead || lead.longChat === true) return undefined;
  if (lead.sessionId && lead.sessionId !== sessionId) return undefined;
  return lead.id;
}

/** The chats to feed now: a long-chat Mono's own chat, or a first mate past the size, idle, not fed since. */
export function treeFeeds(
  sessions: readonly Pick<Session, "id" | "busy" | "blocks">[],
  fedLast: Map<string, string | undefined>,
  monoOf: (sessionId: string) => { id: string; longChat?: boolean; sessionId?: string } | undefined = monoForSession,
  leadOf: (sessionId: string) => string | undefined = () => undefined,
): Array<{ monoId: string; session: Pick<Session, "id" | "blocks">; evenWithoutSetting?: boolean }> {
  const out: Array<{ monoId: string; session: Pick<Session, "id" | "blocks">; evenWithoutSetting?: boolean }> = [];
  for (const session of sessions) {
    if (session.busy) continue;
    const mono = monoOf(session.id);
    let monoId: string | undefined;
    let evenWithoutSetting = false;
    if (mono?.longChat === true) monoId = mono.id;
    else if (mono?.sessionId === session.id && chatBytes(session.blocks) >= LONG_CHAT_THRESHOLD) {
      monoId = mono.id;
      evenWithoutSetting = true;
    } else if (!mono) {
      const leadId = leadOf(session.id);
      if (leadId && chatBytes(session.blocks) >= LONG_CHAT_THRESHOLD) {
        monoId = leadId;
        evenWithoutSetting = true;
      }
    }
    if (!monoId) continue;
    const last = session.blocks[session.blocks.length - 1]?.id;
    if (!last || fedLast.get(session.id) === last) continue;
    fedLast.set(session.id, last);
    out.push(evenWithoutSetting ? { monoId, session, evenWithoutSetting: true } : { monoId, session });
  }
  return out;
}

export function useMonoTrees(sessions: readonly Session[], enabled: boolean): void {
  const on = enabled && isMainWindow();
  const fedLast = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    if (!on) return;
    setTreeCompactor(isolatedCompaction);
    return () => setTreeCompactor(undefined);
  }, [on]);
  useEffect(() => {
    if (!on) return;
    for (const { monoId, session, evenWithoutSetting } of treeFeeds(sessions, fedLast.current, monoForSession, leadForThreshold))
      void feedTree(monoId, session.blocks, evenWithoutSetting ? { evenWithoutSetting: true } : undefined).catch((error) => {
        fedLast.current.delete(session.id);
        console.error(`long chat ${monoId}: not fed`, error);
      });
  }, [sessions, on]);
}
