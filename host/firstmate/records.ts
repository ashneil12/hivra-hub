// Hivra WP-60: delegation records, the wake queue and the catch-up journal on the
// remote host. Launch keys follow Puppetmaster's create_or_get_job (MIT,
// Copyright (c) 2026 Cary, puppetmaster/sqlite_store.py): the same key returns
// the same job, and the same key with a different request is a conflict.

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Wake } from "../../src/features/firstmate/watcher/classifier";
import type {
  CatchUpEntry,
  HostDelegation,
  HostDelegationState,
  HostDelegationStatus,
  HostWake,
  Initiator,
} from "../../src/features/firstmate/host/types";
import type { HostStore } from "../store";

export class LaunchConflictError extends Error {
  constructor() {
    super("launch_key already belongs to a different request");
    this.name = "LaunchConflictError";
  }
}

export type Claim = {
  row: HostDelegation;
  created: boolean;
  /** This caller holds the launch lease and is the one that may start the worker. */
  start: boolean;
  holder: string;
  /** The last try failed in a way that can be sent again. A running row is never this. */
  restart: boolean;
};

type Stored = {
  id: string;
  project_id: string;
  launch_key: string;
  fingerprint: string;
  owner_session: string;
  child_session: string | null;
  generation: number;
  state: HostDelegationState;
  title: string;
  brief: string;
  harness: string;
  model: string;
  runtime_mode: string;
  started_by: Initiator;
  status: HostDelegationStatus;
  result: string | null;
  error: string | null;
  error_class: string | null;
  retryable: number;
  created_at: number;
  updated_at: number;
};

const fromRow = (row: Stored): HostDelegation => ({
  id: row.id,
  projectId: row.project_id,
  launchKey: row.launch_key,
  fingerprint: row.fingerprint,
  ownerSession: row.owner_session,
  childSession: row.child_session,
  generation: row.generation,
  state: row.state,
  title: row.title,
  brief: row.brief,
  harness: row.harness,
  model: row.model,
  runtimeMode: row.runtime_mode,
  startedBy: row.started_by,
  status: row.status,
  result: row.result,
  error: row.error,
  errorClass: row.error_class,
  retryable: row.retryable === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const constraint = (error: unknown) =>
  String(error && typeof error === "object" && "code" in error ? error.code : error).includes("CONSTRAINT");

export function launchFingerprint(parts: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export class FirstMateRecords {
  private readonly db: DatabaseSync;

  constructor(
    private readonly store: HostStore,
    private readonly leaseMs: number,
  ) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fm_delegations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        launch_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        owner_session TEXT NOT NULL,
        child_session TEXT,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT NOT NULL,
        runtime_mode TEXT NOT NULL,
        started_by TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        error_class TEXT,
        retryable INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fm_delegations_child ON fm_delegations(child_session);
      CREATE INDEX IF NOT EXISTS fm_delegations_project ON fm_delegations(project_id);
      CREATE TABLE IF NOT EXISTS fm_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        delegation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        started_by TEXT NOT NULL,
        owner_session TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fm_journal_project ON fm_journal(project_id, seq);
      CREATE TABLE IF NOT EXISTS fm_wakes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_session TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        delegation_id TEXT,
        generation INTEGER,
        title TEXT,
        text TEXT NOT NULL,
        delivery TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_session, key)
      );
      CREATE TABLE IF NOT EXISTS fm_leases (
        key TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        until_ms INTEGER NOT NULL
      );
    `);
    // A database created before the chat was recorded on each line still opens.
    try {
      this.db.exec("ALTER TABLE fm_journal ADD COLUMN owner_session TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column/i.test(message)) throw error;
    }
  }

  get(id: string): HostDelegation | null {
    const row = this.db.prepare("SELECT * FROM fm_delegations WHERE id=?").get(id) as Stored | undefined;
    return row ? fromRow(row) : null;
  }

  byLaunchKey(key: string): HostDelegation | null {
    const row = this.db.prepare("SELECT * FROM fm_delegations WHERE launch_key=?").get(key) as Stored | undefined;
    return row ? fromRow(row) : null;
  }

  byChild(sessionId: string): HostDelegation | null {
    const row = this.db.prepare("SELECT * FROM fm_delegations WHERE child_session=?").get(sessionId) as
      | Stored
      | undefined;
    return row ? fromRow(row) : null;
  }

  list(projectId: string): HostDelegation[] {
    return (this.db.prepare("SELECT * FROM fm_delegations WHERE project_id=? ORDER BY created_at").all(projectId) as Stored[]).map(fromRow);
  }

  running(): HostDelegation[] {
    return (this.db.prepare("SELECT * FROM fm_delegations WHERE state='running'").all() as Stored[]).map(fromRow);
  }

  /**
   * One launch key, one delegation. A second caller with the same fingerprint
   * gets the existing row. A live launch lease means someone is already starting
   * it; an expired lease can be taken (a timeout is not a final failure) but the
   * row is the same one.
   */
  claim(input: {
    projectId: string;
    launchKey: string;
    fingerprint: string;
    ownerSession: string;
    title: string;
    brief: string;
    harness: string;
    model: string;
    runtimeMode: string;
    startedBy: Initiator;
    now: number;
  }): Claim {
    return this.store.transaction(() => {
      const existing = this.byLaunchKey(input.launchKey);
      if (existing) {
        if (
          existing.fingerprint !== input.fingerprint ||
          existing.projectId !== input.projectId ||
          existing.ownerSession !== input.ownerSession ||
          existing.startedBy !== input.startedBy
        ) {
          throw new LaunchConflictError();
        }
        // A retryable failure can be sent again, on this same row. A finished run,
        // or a failure that will not succeed by trying again, is the result.
        if (existing.state === "failed" && existing.retryable) {
          const holder = randomUUID();
          if (!this.takeLease(existing.launchKey, holder, input.now)) {
            return { row: existing, created: false, start: false, holder: "", restart: false };
          }
          const saved = this.db
            .prepare(
              `UPDATE fm_delegations
               SET state='running', status='working', generation=generation+1, retryable=0,
                   result=NULL, error=NULL, error_class=NULL, updated_at=?
               WHERE id=? AND state='failed' AND retryable=1`,
            )
            .run(input.now, existing.id);
          if (saved.changes !== 1) {
            this.db.prepare("DELETE FROM fm_leases WHERE key=? AND holder=?").run(existing.launchKey, holder);
            const current = this.get(existing.id) ?? existing;
            return { row: current, created: false, start: false, holder: "", restart: false };
          }
          const row = this.get(existing.id)!;
          this.journal(row, "started", `Started "${row.title}" again.`, input.now);
          return { row, created: false, start: true, holder, restart: true };
        }
        // A running one can be adopted (the same native session, never a second)
        // by whoever holds the launch lease.
        if (existing.state !== "running") {
          return { row: existing, created: false, start: false, holder: "", restart: false };
        }
        const holder = randomUUID();
        if (!this.takeLease(existing.launchKey, holder, input.now)) {
          return { row: existing, created: false, start: false, holder: "", restart: false };
        }
        return { row: existing, created: false, start: true, holder, restart: false };
      }
      const now = input.now;
      const row: HostDelegation = {
        id: randomUUID(),
        projectId: input.projectId,
        launchKey: input.launchKey,
        fingerprint: input.fingerprint,
        ownerSession: input.ownerSession,
        childSession: null,
        generation: 1,
        state: "running",
        title: input.title,
        brief: input.brief,
        harness: input.harness,
        model: input.model,
        runtimeMode: input.runtimeMode,
        startedBy: input.startedBy,
        status: "working",
        result: null,
        error: null,
        errorClass: null,
        retryable: false,
        createdAt: now,
        updatedAt: now,
      };
      const holder = randomUUID();
      try {
        this.insert(row);
      } catch (error) {
        if (!constraint(error)) throw error;
        const raced = this.byLaunchKey(input.launchKey);
        if (!raced) throw error;
        if (raced.fingerprint !== input.fingerprint) throw new LaunchConflictError();
        return { row: raced, created: false, start: false, holder: "", restart: false };
      }
      this.journal(row, "started", `Started "${row.title}".`, now);
      if (!this.takeLease(row.launchKey, holder, now)) {
        return { row, created: true, start: false, holder: "", restart: false };
      }
      return { row, created: true, start: true, holder, restart: false };
    });
  }

  /** Point a delegation at its native session. Never replaces a different live one. */
  attachChild(id: string, sessionId: string, now: number): HostDelegation {
    return this.store.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error("Delegation not found on this machine");
      if (row.childSession && row.childSession !== sessionId) return row;
      if (row.childSession === sessionId) return row;
      this.db
        .prepare("UPDATE fm_delegations SET child_session=?, updated_at=? WHERE id=? AND child_session IS NULL")
        .run(sessionId, now, id);
      return this.get(id)!;
    });
  }

  releaseLaunchLease(launchKey: string, holder: string): void {
    if (!holder) return;
    this.db.prepare("DELETE FROM fm_leases WHERE key=? AND holder=?").run(launchKey, holder);
  }

  /**
   * Settle a running row once. A second call (the hook and a reconnect both
   * noticing) leaves the journal as it was.
   */
  finish(
    id: string,
    patch: {
      state: HostDelegationState;
      status: HostDelegationStatus;
      result: string | null;
      error: string | null;
      errorClass: string | null;
      retryable: boolean;
    },
    entry: { kind: CatchUpEntry["kind"]; text: string },
    wakes: Wake[],
    now: number,
  ): HostDelegation | null {
    return this.store.transaction(() => {
      const row = this.get(id);
      if (!row || row.state !== "running") return row;
      this.db
        .prepare(
          `UPDATE fm_delegations
           SET state=?, status=?, result=?, error=?, error_class=?, retryable=?, updated_at=?
           WHERE id=? AND state='running'`,
        )
        .run(
          patch.state,
          patch.status,
          patch.result,
          patch.error,
          patch.errorClass,
          patch.retryable ? 1 : 0,
          now,
          id,
        );
      const saved = this.get(id)!;
      if (saved.state === "running") return saved;
      this.journal(saved, entry.kind, entry.text, now);
      for (const wake of wakes) this.enqueue(saved.projectId, wake, now);
      return saved;
    });
  }

  catchUp(projectId: string, after: number): CatchUpEntry[] {
    const rows = this.db
      .prepare(
        "SELECT seq, project_id, delegation_id, kind, started_by, owner_session, text, at FROM fm_journal WHERE project_id=? AND seq>? ORDER BY seq",
      )
      .all(projectId, after) as Array<{
      seq: number;
      project_id: string;
      delegation_id: string;
      kind: CatchUpEntry["kind"];
      started_by: Initiator;
      owner_session: string;
      text: string;
      at: number;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      projectId: row.project_id,
      delegationId: row.delegation_id,
      ownerSession: row.owner_session,
      kind: row.kind,
      startedBy: row.started_by,
      text: row.text,
      at: row.at,
    }));
  }

  wakes(projectId: string): HostWake[] {
    const rows = this.db
      .prepare("SELECT * FROM fm_wakes WHERE project_id=? ORDER BY seq")
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      owner_session: string;
      seq: number;
      kind: string;
      key: string;
      delegation_id: string | null;
      generation: number | null;
      title: string | null;
      text: string;
      delivery: HostWake["delivery"];
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      ownerSession: row.owner_session,
      seq: row.seq,
      kind: row.kind,
      key: row.key,
      delegationId: row.delegation_id,
      generation: row.generation,
      title: row.title,
      text: row.text,
      delivery: row.delivery,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private takeLease(launchKey: string, holder: string, now: number): boolean {
    const until = now + this.leaseMs;
    const current = this.db.prepare("SELECT holder, until_ms FROM fm_leases WHERE key=?").get(launchKey) as
      | { holder: string; until_ms: number }
      | undefined;
    if (!current) {
      try {
        this.db.prepare("INSERT INTO fm_leases VALUES (?, ?, ?)").run(launchKey, holder, until);
        return true;
      } catch (error) {
        if (!constraint(error)) throw error;
        return false;
      }
    }
    if (current.until_ms > now && current.holder !== holder) return false;
    this.db.prepare("UPDATE fm_leases SET holder=?, until_ms=? WHERE key=?").run(holder, until, launchKey);
    return true;
  }

  private insert(row: HostDelegation): void {
    this.db
      .prepare(
        `INSERT INTO fm_delegations (
          id, project_id, launch_key, fingerprint, owner_session, child_session, generation,
          state, title, brief, harness, model, runtime_mode, started_by, status, result, error,
          error_class, retryable, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.launchKey,
        row.fingerprint,
        row.ownerSession,
        row.childSession,
        row.generation,
        row.state,
        row.title,
        row.brief,
        row.harness,
        row.model,
        row.runtimeMode,
        row.startedBy,
        row.status,
        row.result,
        row.error,
        row.errorClass,
        row.retryable ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      );
  }

  private journal(row: HostDelegation, kind: CatchUpEntry["kind"], text: string, now: number): void {
    this.db
      .prepare(
        "INSERT INTO fm_journal (project_id, delegation_id, kind, started_by, owner_session, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.projectId, row.id, kind, row.startedBy, row.ownerSession, text, now);
  }

  private enqueue(projectId: string, wake: Wake, now: number): void {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM fm_wakes WHERE owner_session=?")
      .get(wake.ownerSession) as { seq: number };
    try {
      this.db
        .prepare(
          `INSERT INTO fm_wakes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          randomUUID(),
          projectId,
          wake.ownerSession,
          seqRow.seq + 1,
          wake.kind,
          wake.key,
          wake.delegationId ?? null,
          wake.generation ?? null,
          wake.title ?? null,
          wake.text,
          now,
          now,
        );
    } catch (error) {
      if (!constraint(error)) throw error;
    }
  }
}
