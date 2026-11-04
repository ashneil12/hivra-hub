// Hivra WP-60: the first mate's records, wake queue and classifier, running on the
// remote host so a project keeps going with the laptop closed.
//
// A launch key starts at most one worker (Puppetmaster, MIT). A live native
// session is never replaced with a fresh one (AgentOS harness custody, MIT,
// Copyright (c) 2026 Akua): a reconnect adopts the session that is already there.

import { dirname, join } from "node:path";
import { classify, type Decision, type RowFacts, type Wake } from "../../src/features/firstmate/watcher/classifier";
import {
  INITIATORS,
  type CatchUpEntry,
  type HostDelegation,
  type HostWake,
  type Initiator,
} from "../../src/features/firstmate/host/types";
import { isRemoteProvider, type RemoteProvider } from "../../src/features/connections/model/protocol";
import { RUNTIME_MODES, type RuntimeMode, type Session } from "../../src/features/sessions/model/session";
import type { HostEngine, TurnSettlement } from "../engine";
import type { HostSession } from "../../src/features/connections/model/protocol";
import { acquireSessionLease, type SessionLease } from "./lease";
import { FirstMateRecords, LaunchConflictError, launchFingerprint } from "./records";

export { LaunchConflictError };

const LEASE_MS = 15_000;

/** A dropped connection or a timeout is not a final failure: the same launch can be adopted. */
export function retryableFailure(message: string): boolean {
  return /timed?\s*out|timeout|econnrefused|enotfound|eai_again|ehostunreach|etimedout|unreachable|network error|socket hang up|host restarted|host stopped|storage failed/i.test(
    message,
  );
}

const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
};

/** Launch keys are caller-chosen and come back on every retry, so they stay path-safe. */
function launchKey(value: unknown): string {
  const key = text(value, "launch key", 200);
  if (key !== value || /[/\\\s]|\.\./.test(key)) throw new Error("Invalid launch key");
  return key;
}

type Brief = {
  projectId: string;
  launchKey: string;
  ownerSession: string;
  title: string;
  brief: string;
  harness: RemoteProvider;
  model: string;
  runtimeMode: RuntimeMode;
  startedBy: Initiator;
};

function parseBrief(raw: unknown): Brief {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid brief");
  const v = raw as Record<string, unknown>;
  if (!isRemoteProvider(v.harness) || !RUNTIME_MODES.includes(v.runtimeMode as never)) {
    throw new Error("Invalid provider or permission mode");
  }
  if (!INITIATORS.includes(v.startedBy as Initiator)) throw new Error("Invalid initiator");
  return {
    projectId: text(v.projectId, "project ID", 128),
    launchKey: launchKey(v.launchKey),
    ownerSession: text(v.ownerSession, "owner session", 128),
    title: text(v.title, "title", 200),
    brief: text(v.brief, "brief", 100_000),
    harness: v.harness,
    model: text(v.model, "model", 200),
    runtimeMode: v.runtimeMode as RuntimeMode,
    startedBy: v.startedBy as Initiator,
  };
}

function facts(row: HostDelegation): RowFacts {
  return {
    id: row.id,
    ownerSession: row.ownerSession,
    childSession: row.childSession ?? "",
    generation: row.generation,
    state: row.state,
    title: row.title,
    status: row.status,
    error: row.error,
  };
}

function lastText(session: HostSession, role: Session["blocks"][number]["role"]): string {
  for (let i = session.session.blocks.length - 1; i >= 0; i--) {
    const block = session.session.blocks[i];
    if (block.role === role && block.text.trim()) return block.text.trim();
  }
  return "";
}

const turnStarted = (session: HostSession) => session.session.blocks.some((block) => block.role === "user");

/** A report is the catch-up line. It is not left on the wake table. */
function keptWakes(decisions: Decision[]): Wake[] {
  return decisions.flatMap((decision) =>
    decision.kind === "wake" && decision.wake.route !== "report" ? [decision.wake] : [],
  );
}

export class HostFirstMate {
  private readonly records: FirstMateRecords;
  private readonly leaseRoot: string;
  private readonly sessionLeases = new Map<string, SessionLease>();
  private readonly now: () => number;

  constructor(
    private readonly engine: HostEngine,
    options?: { leaseMs?: number; now?: () => number },
  ) {
    this.now = options?.now ?? (() => Date.now());
    this.records = new FirstMateRecords(engine.store, options?.leaseMs ?? LEASE_MS);
    this.leaseRoot = join(dirname(engine.store.attachmentDir), "firstmate-leases");
    // WP-60: a turn that finishes on the host settles its brief with no desktop connected.
    engine.onSettled((session, info) => this.onTurnSettled(session, info));
    this.recover();
  }

  /** Start a brief, or return the worker this launch key already started. */
  brief(raw: unknown): { delegation: HostDelegation; created: boolean } {
    const input = parseBrief(raw);
    this.engine.store.project(input.projectId);
    const claim = this.records.claim({
      ...input,
      fingerprint: launchFingerprint({
        projectId: input.projectId,
        ownerSession: input.ownerSession,
        title: input.title,
        brief: input.brief,
        harness: input.harness,
        model: input.model,
        runtimeMode: input.runtimeMode,
        startedBy: input.startedBy,
      }),
      now: this.now(),
    });
    try {
      const row = claim.start ? this.ensureWorker(claim.row, claim.restart) : claim.row;
      return { delegation: this.records.get(row.id) ?? row, created: claim.created };
    } finally {
      if (claim.start) this.records.releaseLaunchLease(claim.row.launchKey, claim.holder);
    }
  }

  catchUp(projectId: unknown, after: unknown): { entries: CatchUpEntry[] } {
    const id = text(projectId, "project ID", 128);
    this.engine.store.project(id);
    if (after !== undefined && after !== null && (!Number.isSafeInteger(after) || Number(after) < 0)) {
      throw new Error("Invalid catch-up cursor");
    }
    return { entries: this.records.catchUp(id, after == null ? 0 : Number(after)) };
  }

  list(projectId: unknown): HostDelegation[] {
    const id = text(projectId, "project ID", 128);
    this.engine.store.project(id);
    return this.records.list(id);
  }

  wakes(projectId: unknown): HostWake[] {
    const id = text(projectId, "project ID", 128);
    this.engine.store.project(id);
    return this.records.wakes(id);
  }

  /**
   * The same native session this brief already has. Creates one only when the
   * launch has none. Sends the brief at most once, and settles a turn that
   * already finished while nobody was watching.
   */
  private ensureWorker(row: HostDelegation, restart: boolean): HostDelegation {
    let current = row;
    if (!current.childSession) {
      const created = this.engine.command({
        type: "create",
        commandId: `fm-${current.id}-create`,
        projectId: current.projectId,
        harness: current.harness as RemoteProvider,
        model: current.model,
        runtimeMode: current.runtimeMode as RuntimeMode,
      });
      current = this.records.attachChild(current.id, created.sessionId, this.now());
    }
    if (!current.childSession) return current;
    let session: HostSession;
    try {
      session = this.engine.store.session(current.childSession);
    } catch (error) {
      // The native session is gone. Do not mint a fresh one over this launch.
      if (!(error instanceof Error) || !error.message.includes("Session not found")) throw error;
      return current;
    }
    if (session.status === "running" || current.state !== "running") return current;
    // A retryable failure is sent again. A first try is sent once. A turn that
    // already finished is settled instead, never started a second time.
    if ((restart || !turnStarted(session)) && (session.status === "idle" || session.status === "interrupted")) {
      this.sendBrief(current, session.session.id);
      return this.records.get(current.id) ?? current;
    }
    this.finishFromSession(current, session);
    return this.records.get(current.id) ?? current;
  }

  private sendBrief(row: HostDelegation, sessionId: string): void {
    const lease = acquireSessionLease(sessionId, this.leaseRoot);
    // Another live holder already drives this session. Say so, and let the same launch try again.
    if (!lease) {
      this.failUnsent(row, "This session is in use, so the brief was not sent. Try the same launch again.");
      return;
    }
    this.sessionLeases.set(sessionId, lease);
    try {
      this.engine.command({
        type: "send",
        commandId: `fm-${row.id}-g${row.generation}-send`,
        sessionId,
        text: row.brief,
      });
    } catch (error) {
      this.releaseSession(sessionId);
      throw error;
    }
  }

  private onTurnSettled(session: HostSession, info: TurnSettlement): void {
    const row = this.records.byChild(session.session.id);
    if (!row || row.state !== "running") {
      this.releaseSession(session.session.id);
      return;
    }
    this.finish(row, session, info);
  }

  /** A host that restarted had already marked running turns interrupted before this listener existed. */
  private recover(): void {
    for (const row of this.records.running()) {
      if (!row.childSession) continue;
      let session: HostSession;
      try {
        session = this.engine.store.session(row.childSession);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Session not found")) throw error;
        continue;
      }
      if (session.status === "running") continue;
      if (session.status === "idle" && !turnStarted(session)) continue;
      this.finishFromSession(row, session);
    }
  }

  private finishFromSession(row: HostDelegation, session: HostSession): void {
    const text = lastText(session, "system");
    const cancelled = text === "Stopped by you.";
    const interrupted =
      session.status === "interrupted" || /interrupted|Host stopped|Host restarted|storage failed/i.test(text);
    this.finish(row, session, { error: text || undefined, cancelled, interrupted });
  }

  private finish(row: HostDelegation, session: HostSession, info: TurnSettlement): void {
    const now = this.now();
    const said = lastText(session, "assistant");
    let patch: {
      state: HostDelegation["state"];
      status: HostDelegation["status"];
      result: string | null;
      error: string | null;
      errorClass: string | null;
      retryable: boolean;
    };
    let entry: { kind: CatchUpEntry["kind"]; text: string };
    if (info.cancelled) {
      patch = { state: "cancelled", status: "paused", result: null, error: null, errorClass: null, retryable: false };
      entry = { kind: "cancelled", text: "Stopped by you." };
    } else if (info.error || info.interrupted) {
      const error = info.error || "This turn was interrupted.";
      const retryable = info.interrupted || retryableFailure(error);
      patch = { state: "failed", status: "failed", result: null, error, errorClass: retryable ? "unavailable" : null, retryable };
      entry = { kind: "failed", text: error };
    } else {
      patch = { state: "completed", status: "done", result: said || null, error: null, errorClass: null, retryable: false };
      entry = { kind: "finished", text: said || `"${row.title}" is done.` };
    }
    const after: HostDelegation = { ...row, ...patch, updatedAt: now };
    const wakes = keptWakes(classify({ kind: "row", before: facts(row), row: facts(after) }, now));
    this.records.finish(row.id, patch, entry, wakes, now);
    this.releaseSession(session.session.id);
  }

  /** A brief that never left this machine. Retryable, and not left running. */
  private failUnsent(row: HostDelegation, error: string): void {
    const now = this.now();
    const patch = {
      state: "failed" as const,
      status: "failed" as const,
      result: null,
      error,
      errorClass: "unavailable",
      retryable: true,
    };
    const after: HostDelegation = { ...row, ...patch, updatedAt: now };
    this.records.finish(
      row.id,
      patch,
      { kind: "failed", text: error },
      keptWakes(classify({ kind: "row", before: facts(row), row: facts(after) }, now)),
      now,
    );
  }

  private releaseSession(sessionId: string): void {
    const lease = this.sessionLeases.get(sessionId);
    if (!lease) return;
    this.sessionLeases.delete(sessionId);
    lease.release();
  }
}
