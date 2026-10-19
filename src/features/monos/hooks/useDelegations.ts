// The app's one hook for delegation rows (model/delegations.ts): one tracker per window, boot recovery in the main
// window, and each chat's Claude session bound for Ash OS (`ash-hub-chat-bind`) whenever it binds or rotates.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { leadFor } from "../../hub/model/hubLeads";
import { getSession } from "../../sessions/data/sessionStore";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import {
  DelegationTracker,
  tauriDelegations,
  type ChatBindInput,
  type DelegationsBackend,
} from "../model/delegations";
import { isMonoSession, monoForSession } from "../model/mono";

/** Boot recovery runs once per page load of the main window (React's dev double mount runs it once too). */
let recovered = false;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** Who a Claude session is, for Ash OS: a Mono's chat (a Lead or not), a delegated worker, or a plain chat. */
export function chatBinding(
  session: Pick<Session, "id" | "harness" | "providerSessionId">,
  openDelegation?: string,
): ChatBindInput | undefined {
  if (session.harness !== "claude" || !session.providerSessionId) return;
  const mono = monoForSession(session.id);
  const role = mono
    ? leadFor(mono.id)
      ? "lead"
      : "mono"
    : openDelegation
      ? "worker"
      : undefined;
  return {
    providerSession: session.providerSessionId,
    chatId: session.id,
    ...(mono ? { monoId: mono.id } : {}),
    ...(role ? { role } : {}),
    ...(openDelegation ? { delegationId: openDelegation } : {}),
  };
}

export function useDelegations(options: {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  /** Open a chat in this window (ensureOpenSession). */
  openSession: (id: string) => Promise<Session | null>;
  /** Put a report in a Mono's queue (queueMonoSessionCompletion). */
  queueReport: (monoId: string, message: QueuedMessage) => Promise<void>;
  quitting: () => boolean;
  backend?: DelegationsBackend;
}): DelegationTracker {
  const latest = useRef(options);
  latest.current = options;
  const [tracker] = useState(
    () =>
      new DelegationTracker(options.backend ?? tauriDelegations, {
        session: (id) =>
          latest.current.sessionsRef.current.find((s) => s.id === id),
        load: async (id) =>
          latest.current.sessionsRef.current.find((s) => s.id === id) ??
          (await getSession(id).catch(() => null)),
        openOwner: (id) => latest.current.openSession(id),
        isMono: isMonoSession,
        queueReport: (monoId, message) =>
          latest.current.queueReport(monoId, message),
        quitting: () => latest.current.quitting(),
      }),
  );

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const recover = !recovered && isMainWindow();
    if (recover) recovered = true;
    let live = true;
    void tracker
      .boot(recover)
      .catch((error: unknown) => {
        console.error("Delegation boot recovery failed", error);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [tracker]);

  // On every provider bind (a new chat, a rotated Mono chat), once the open rows are known so a worker says so.
  const bound = useRef(new Map<string, string>());
  const { sessions } = options;
  useEffect(() => {
    if (!loaded) return;
    for (const session of sessions) {
      if (session.harness !== "claude" || !session.providerSessionId) continue;
      if (bound.current.get(session.id) === session.providerSessionId) continue;
      bound.current.set(session.id, session.providerSessionId);
      const binding = chatBinding(session, tracker.openRowFor(session.id)?.id);
      if (binding) tracker.bindChat(binding);
    }
  }, [loaded, sessions, tracker]);

  return tracker;
}
