// The checker's notes reach their chats (hub/model/hubChecks.ts; docs/PHASE-2-DESIGN.md decision 4, H6). In the Hub
// bundle's main window only: each goes to its owner's chat as one quiet `[MonoCode check]` turn once that chat is idle.
// Two sources: Ash OS's undelivered checks (at boot and on feed topic `checks`), and the light look after each dump
// (hub/model/dumpCheck.ts; Ash, 21 Oct: no hourly audit), run here once the chat that sent one is idle. Every dump in
// any hub chat is written down the moment it arrives (B5: a chat quit before answering is still checkable).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SubmissionAcceptance } from "../model/submissionAcceptance";
import type { Block, Session } from "../../features/sessions/model/session";
import { findMono, monoForSession } from "../../features/monos/model/mono";
import { hubCheckFeed } from "../../features/hub/model/hubData";
import { CHECKER_MONO_ID, ensureChecker } from "../../features/hub/model/hubChecker";
import { CheckDelivery, checkMeta, checkReceipt } from "../../features/hub/model/hubChecks";
import { lastUserBlockId, lookAtDumps, noteDumps } from "../../features/hub/model/dumpCheck";
import { hubEvidenceSource } from "../../features/hub/model/askEvidence";
import { settleAsks } from "../../features/hub/model/askSettle";
import { askMateFor } from "../../features/asks/model/askMate";
import { routeHubDump } from "../../features/asks/model/hubRoute";
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
  /** The one cheap look after a dump; defaults to an isolated Claude Code prompt on the runtime's own model. */
  look?(prompt: string): Promise<string>;
  /** r85: titles of a chat's own jobs still being built, so a "now does X" before they land is checked. */
  openJobs?(sessionId: string): readonly string[];
};

const LOOK_TIMEOUT_MS = 90_000;

/**
 * A dump noticed in a chat that is no first mate's goes into the ask ledger (asks/model/hubRoute.ts), the one ledger the
 * Chief's "You asked" list reads. A first mate's chat is heard by the ledger's own hook, with the model.
 */
const routeDump = (dump: Parameters<typeof routeHubDump>[0]): void => {
  void routeHubDump(dump, askMateFor).catch((error: unknown) => console.warn("An ask could not be written down", error));
};

async function isolatedLook(prompt: string): Promise<string> {
  if (!canRunHarnessTextPrompt("claude")) throw new Error("No engine for the dump check");
  return runHarnessTextPrompt({ harness: "claude", cwd: await homeDir(), prompt, intent: "plan", timeoutMs: LOOK_TIMEOUT_MS });
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

  // Write down each dump when it arrives, before any answer exists, so quitting or cutting the chat loses nothing.
  // Keyed on which chat got a new latest message, not on every streamed token.
  const newest = useMemo(() => host.sessions.map((session) => `${session.id}:${lastUserBlockId(session)}`).join(" "), [host.sessions]);
  useEffect(() => {
    if (!on) return;
    noteDumps(latest.current.sessionsRef.current, undefined, undefined, routeDump);
  }, [on, newest]);

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
    // The checker's own chat only reads; a check there would be a note about a note.
    const skip = (id: string) => monoForSession(id)?.id === CHECKER_MONO_ID;
    void delivery.flush();
    void lookAtDumps(
      latest.current.sessionsRef.current,
      latest.current.look ?? isolatedLook,
      (checks) => delivery.offer(checks),
      { skip, source: hubEvidenceSource, onNewDump: routeDump },
    ).then(() =>
      // Then every open ask is settled against what was built (I6): a "fixed" or a done claim with nothing behind it
      // stays open and one private check says what is missing.
      settleAsks(latest.current.sessionsRef.current, hubEvidenceSource, (checks) => delivery.offer(checks), {
        skip,
        openJobs: (id) => latest.current.openJobs?.(id) ?? [],
      }),
    ).catch((error: unknown) => console.warn("The dump check failed", error));
  }, [on, delivery, idle]);
}
