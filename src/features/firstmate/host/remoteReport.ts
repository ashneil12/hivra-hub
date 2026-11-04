// Hivra WP-60: a remote project's result, shown once in the chat that started it.
// The host's journal is the record. This only places that line in the chat.

import { enqueueMonoSessionCompletion } from "../../monos/model/monoSessionCompletion";
import type { Session } from "../../sessions/model/session";
import type { CatchUpEntry } from "./types";

/** Who started the work, then what the host recorded. One id per journal line. */
export function remoteReportMessage(entry: CatchUpEntry) {
  const who =
    entry.startedBy === "schedule"
      ? "A schedule started this."
      : entry.startedBy === "first-mate"
        ? "The first mate started this."
        : "You started this.";
  const status: "completed" | "failed" | "cancelled" =
    entry.kind === "failed" ? "failed" : entry.kind === "cancelled" ? "cancelled" : "completed";
  return {
    id: `fm-remote-${entry.projectId}-${entry.seq}`,
    text: `${who} ${entry.text}`,
    attachments: [],
    monoSessionCompletion: { sessionId: entry.delegationId, title: "Host", status },
  };
}

/** Put the report on the chat that started it. A missing chat is not placed. A repeat is still placed. */
export function placeRemoteReport(
  sessions: Session[],
  entry: CatchUpEntry,
): { sessions: Session[]; placed: boolean } {
  const index = sessions.findIndex((session) => session.id === entry.ownerSession);
  if (index < 0) return { sessions, placed: false };
  const next = enqueueMonoSessionCompletion(sessions[index], remoteReportMessage(entry));
  if (next === sessions[index]) return { sessions, placed: true };
  const copy = sessions.slice();
  copy[index] = next;
  return { sessions: copy, placed: true };
}

type Sink = (entry: CatchUpEntry) => Promise<boolean> | boolean;

let sink: Sink | null = null;

/** The open app registers how a report reaches a chat. Tests set this directly. */
export function setRemoteReportDelivery(next: Sink | null): void {
  sink = next;
}

/**
 * Hand each result to the registered chat. Nothing registered, or one chat that
 * cannot take it, refuses the page so the cursor stays and the next poll retries.
 * A line with no chat (an older host) does not block the rest.
 */
export async function deliverRemoteReports(entries: CatchUpEntry[]): Promise<boolean> {
  if (!sink) return false;
  for (const entry of entries) {
    if (!entry.ownerSession.trim()) continue;
    if (!(await sink(entry))) return false;
  }
  return true;
}

export type RemoteReportDeps = {
  isOrchestrator: (id: string) => boolean;
  isRemoving: (id: string) => boolean;
  ensureOpen: (id: string) => Promise<unknown>;
  place: (entry: CatchUpEntry) => boolean;
};

/** Register delivery for as long as the caller is mounted. The return clears it. */
export function bindRemoteReports(deps: RemoteReportDeps): () => void {
  setRemoteReportDelivery(async (entry) => {
    if (!entry.ownerSession.trim()) return true;
    if (!deps.isOrchestrator(entry.ownerSession) || deps.isRemoving(entry.ownerSession)) return false;
    if (!(await deps.ensureOpen(entry.ownerSession)) || deps.isRemoving(entry.ownerSession)) return false;
    return deps.place(entry);
  });
  return () => setRemoteReportDelivery(null);
}
