// The app's one hook for delegation rows (model/delegations.ts): one tracker per window, boot recovery in the main
// window, and each chat's Claude session bound (`delegations_bind_chat`) whenever it binds or rotates.
import type { CrewFailureNote } from "../../crew/model/advice";
import type { MonoSessionCompletionResult } from "../model/monoSessionCompletion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { leadFor } from "../../hub/model/hubLeads";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { getSession } from "../../sessions/data/sessionStore";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import {
  bootUntilLoaded,
  DelegationTracker,
  tauriDelegations,
  type ChatBindInput,
  type Delegation,
  type DelegationsBackend,
} from "../model/delegations";
import { monoForSession } from "../model/mono";
import { isOrchestratorChat } from "../model/orchestrators";

/**
 * Boot recovery runs once per page load of the main window (React's dev double mount runs it once too): one attempt
 * claims it, and a failed one hands it back for the next attempt.
 */
let recovery: "pending" | "running" | "done" = "pending";

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/**
 * Who a Claude session is, for Ash OS: a Mono's chat (a Lead, the checker, or another), a worker, or a plain chat. A
 * chat started through the app CLI (`app-<caller>-<request>`) stays a worker after its task finished, as its Ash OS
 * identity does (hub/model/hubMcp.ts), so a rebind at the next launch never drops the role.
 */
export function chatBinding(
  session: Pick<Session, "id" | "harness" | "providerSessionId">,
  openDelegation?: string,
): ChatBindInput | undefined {
  if (session.harness !== "claude" || !session.providerSessionId) return;
  const mono = monoForSession(session.id);
  const role = mono
    ? mono.id === CHECKER_MONO_ID
      ? "checker"
      : leadFor(mono.id)
        ? "lead"
        : "mono"
    : openDelegation || session.id.startsWith("app-")
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
  /** r84: lands a resumed worker's finished changes (workerLanding.ts). */
  land?: (result: MonoSessionCompletionResult) => Promise<MonoSessionCompletionResult>;
  /** WP-13: an account failure is recorded. The note can name the next signed-in CLI. */
  crewFailure?: (row: Delegation, result: MonoSessionCompletionResult) => Promise<CrewFailureNote | undefined>;
  /** SC-19: this request's report is still on its way from the app's batches (MonoSessionCompletionBatches.holds). */
  reportHeld?: (requestId: string) => boolean;
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
        // A coding-team chat owns its workers' reports like a Mono does (orchestrators.ts).
        isMono: isOrchestratorChat,
        queueReport: (monoId, message) =>
          latest.current.queueReport(monoId, message),
        quitting: () => latest.current.quitting(),
        land: (result) => latest.current.land?.(result) ?? Promise.resolve(result),
        reportHeld: (requestId) => latest.current.reportHeld?.(requestId) ?? false,
        // WP-13: read on each settle, so a later render's callback is the one that runs.
        ...(options.crewFailure
          ? { crewFailure: (row: Delegation, result: MonoSessionCompletionResult) => latest.current.crewFailure!(row, result) }
          : {}),
      }),
  );

  // Each finished boot attempt; the rows may have loaded on a later one (it is retried until they do).
  const [attempts, setAttempts] = useState(0);
  useEffect(() => {
    let live = true;
    void bootUntilLoaded(tracker, {
      live: () => live,
      recover: () => {
        if (recovery !== "pending" || !isMainWindow()) return false;
        recovery = "running";
        return true;
      },
      attempted: ({ recover, loaded }) => {
        if (recover) recovery = loaded ? "done" : "pending";
        if (live) setAttempts((count) => count + 1);
      },
    });
    return () => {
      live = false;
    };
  }, [tracker]);

  // On every provider bind (a new chat, a rotated Mono chat), after the first boot attempt so a worker says so. A chat
  // bound before the open rows loaded is bound once more when they do (the tracker sends only what changed).
  const bound = useRef(new Map<string, string>());
  const { sessions } = options;
  useEffect(() => {
    if (!attempts) return;
    const loaded = tracker.isLoaded();
    for (const session of sessions) {
      if (session.harness !== "claude" || !session.providerSessionId) continue;
      const done = `${session.providerSessionId}\u0000loaded`;
      const seen = loaded ? done : `${session.providerSessionId}\u0000early`;
      const previous = bound.current.get(session.id);
      if (previous === seen || previous === done) continue;
      bound.current.set(session.id, seen);
      const binding = chatBinding(session, tracker.openRowFor(session.id)?.id);
      if (binding) tracker.bindChat(binding);
    }
  }, [attempts, sessions, tracker]);

  return tracker;
}
