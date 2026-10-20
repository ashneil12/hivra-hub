// The checker's notes reach their chats (hub/model/hubChecks.ts; docs/PHASE-2-DESIGN.md decision 4, H6). In the Hub
// bundle's main window only: the store pulls the undelivered checks (at boot and on feed topic `checks`), and each goes
// to its owner's chat as one quiet `[MonoCode check]` turn once that chat is idle. This hook also makes the Checker
// Mono (hub/model/hubChecker.ts) and opens its chat, since a habit runs only for a Mono whose chat exists.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { SubmissionAcceptance } from "../model/submissionAcceptance";
import type { Block, Session } from "../../features/sessions/model/session";
import { findMono } from "../../features/monos/model/mono";
import { hubCheckFeed } from "../../features/hub/model/hubData";
import { CHECKER_MONO_ID, ensureChecker } from "../../features/hub/model/hubChecker";
import { CheckDelivery, checkMeta, checkReceipt } from "../../features/hub/model/hubChecks";

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
};

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
          await hubCheckFeed()?.checksDelivered(ids);
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
    if (on) void delivery.flush();
  }, [on, delivery, idle]);
}
