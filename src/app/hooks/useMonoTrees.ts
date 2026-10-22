// Long chats (monos/model/monoTreeStore.ts, "Keep one long chat"): each finished turn of a long-chat Mono's own chat
// goes into its summary tree, from the blocks the chat already keeps. In the Hub bundle's main window only, so two
// windows never write one tree. The summaries run on the hub's cheap isolated call (the same one the dump check
// uses), in the background; nothing here waits on them or holds a turn.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import type { Session } from "../../features/sessions/model/session";
import { monoForSession } from "../../features/monos/model/mono";
import { feedTree, setTreeCompactor } from "../../features/monos/model/monoTreeStore";
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

/** The chats to feed now: a long-chat Mono's own chat, idle, with blocks it hasn't been fed since. */
export function treeFeeds(
  sessions: readonly Pick<Session, "id" | "busy" | "blocks">[],
  fedLast: Map<string, string | undefined>,
  monoOf: (sessionId: string) => { id: string; longChat?: boolean } | undefined = monoForSession,
): Array<{ monoId: string; session: Pick<Session, "id" | "blocks"> }> {
  const out: Array<{ monoId: string; session: Pick<Session, "id" | "blocks"> }> = [];
  for (const session of sessions) {
    if (session.busy) continue;
    const mono = monoOf(session.id);
    if (mono?.longChat !== true) continue;
    const last = session.blocks[session.blocks.length - 1]?.id;
    if (!last || fedLast.get(session.id) === last) continue;
    fedLast.set(session.id, last);
    out.push({ monoId: mono.id, session });
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
    for (const { monoId, session } of treeFeeds(sessions, fedLast.current))
      void feedTree(monoId, session.blocks).catch((error) => {
        fedLast.current.delete(session.id);
        console.error(`long chat ${monoId}: not fed`, error);
      });
  }, [sessions, on]);
}
