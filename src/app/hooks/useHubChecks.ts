// The checker's notes reach their chats (hub/model/hubChecks.ts; docs/PHASE-2-DESIGN.md decision 4, H6). In the Hub
// bundle's main window only: each goes to its owner's chat as one quiet `[MonoCode check]` turn once that chat is idle.
// Two sources: Ash OS's undelivered checks (at boot and on feed topic `checks`), and the light look after each dump
// (hub/model/dumpCheck.ts; Ash, 21 Oct: no hourly audit), run here once a chat Ash talks to has answered one.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SubmissionAcceptance } from "../model/submissionAcceptance";
import type { Block, Session } from "../../features/sessions/model/session";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import { hubCheckFeed } from "../../features/hub/model/hubData";
import { CHECKER_MONO_ID, ensureChecker } from "../../features/hub/model/hubChecker";
import { CheckDelivery, checkMeta, checkReceipt, type HubCheck } from "../../features/hub/model/hubChecks";
import { answeredDump, claimDumpCheck, dumpCheck, dumpCheckPrompt, parseMissed } from "../../features/hub/model/dumpCheck";
import { isOrchestratorChat } from "../../features/monos/model/orchestrators";
import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../../integrations/harness";
import { homeDir } from "../../platform/tauri/fs";

const FLUSH_MS = 60_000;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export type HubChecksHost = {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  /** A chat by id, loaded into this window (ensureOpenSession). */
  openSession(id: string): Promise<Session | null | undefined>;
  /** A Mono's chat, made if it has none yet (ensureMonoSession). */
  openMono(monoId: string): Promise<Session | undefined>;
  submit(
    sessionId: string,
    text: string,
    options: { monoCheck: Block["monoCheck"]; appRequestId: string },
  ): SubmissionAcceptance;
  /** The one cheap look after a dump; defaults to an isolated Claude Code prompt. */
  look?(prompt: string): Promise<string>;
};

const LOOK_TIMEOUT_MS = 90_000;

async function isolatedLook(prompt: string): Promise<string> {
  if (!canRunHarnessTextPrompt("claude")) throw new Error("No engine for the dump check");
  return runHarnessTextPrompt({ harness: "claude", cwd: await homeDir(), prompt, intent: "plan", model: "claude:haiku", timeoutMs: LOOK_TIMEOUT_MS });
}

/** Look at each answered dump once; offer a check when something looks missed. */
export async function lookAtDumps(
  sessions: readonly Session[],
  look: (prompt: string) => Promise<string>,
  offer: (checks: HubCheck[]) => unknown,
): Promise<void> {
  for (const session of sessions) {
    if (session.busy || session.queuedMessages?.length || monoForSession(session.id)?.id === CHECKER_MONO_ID || !isOrchestratorChat(session.id)) continue;
    const dump = answeredDump(session);
    if (!dump || !claimDumpCheck(dump.ask.id)) continue;
    const missed = parseMissed(await look(dumpCheckPrompt(dump.ask.text ?? "", dump.reply)).catch(() => ""));
    if (missed.length) await offer([dumpCheck(session.id, dump.ask, missed)]);
  }
}

export function useHubChecks(host: HubChecksHost, enabled: boolean): void {
  const latest = useRef(host);
  latest.current = host;
  const on = enabled && isMainWindow();
  const [delivery] = useState(
    () =>
      new CheckDelivery({
        open: async (target) =>
          ("mono" in target
            ? await latest.current.openMono(target.mono)
            : await latest.current.openSession(target.session)) ?? undefined,
        current: (id) => latest.current.sessionsRef.current.find((session) => session.id === id),
        submit: async (sessionId, check) =>
          !!(await latest.current.submit(sessionId, check.prompt, {
            monoCheck: checkMeta(check),
            appRequestId: checkReceipt(check.id),
          })),
        delivered: async (ids) => {
          // The app's own dump checks (dc-...) have nothing to confirm in Ash OS.
          const ashOs = ids.filter((id) => !id.startsWith("dc-"));
          if (ashOs.length) await hubCheckFeed()?.checksDelivered(ashOs);
        },
        monoExists: (id) => !!findMono(id),
      }),
  );

  useEffect(() => {
    if (!on) return;
    const feed = hubCheckFeed();
    if (!feed) return;
    // Keeps the store running whichever screen is open, so checks keep arriving.
    const keep = feed.subscribe(() => undefined);
    const off = feed.onChecks((checks) => void delivery.offer(checks));
    const timer = window.setInterval(() => void delivery.flush(), FLUSH_MS);
    let live = true;
    void ensureChecker()
      .then(async () => {
        if (live && findMono(CHECKER_MONO_ID) && !findMono(CHECKER_MONO_ID)?.sessionId)
          await latest.current.openMono(CHECKER_MONO_ID);
      })
      .catch((error: unknown) => console.warn("The checker could not be set up", error));
    return () => {
      live = false;
      keep();
      off();
      window.clearInterval(timer);
    };
  }, [on, delivery]);

  // A chat that went idle may be waiting for a check. Keyed on which chats are idle, not on every streamed token.
  const idle = useMemo(
    () =>
      host.sessions
        .filter((session) => !session.busy && !session.queuedMessages?.length)
        .map((session) => session.id)
        .join(" "),
    [host.sessions],
  );
  useEffect(() => {
    if (!on) return;
    void delivery.flush();
    void lookAtDumps(latest.current.sessionsRef.current, latest.current.look ?? isolatedLook, (checks) => delivery.offer(checks)).catch(
      (error: unknown) => console.warn("The dump check failed", error),
    );
  }, [on, delivery, idle]);
}
