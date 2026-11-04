// Hivra WP-60: the records a remote host keeps for a project's first mate, and the
// catch-up the desktop reads when it reconnects. Shared by the host and the desktop
// client; no Node or DOM imports.

/** What started a run. Stamped on the record so a reconnect can say who did. */
export type Initiator = "person" | "schedule" | "first-mate";

export const INITIATORS: readonly Initiator[] = ["person", "schedule", "first-mate"];

export type HostDelegationState = "running" | "completed" | "failed" | "cancelled";

export type HostDelegationStatus = "working" | "needs you" | "done" | "failed" | "paused";

/** One brief the host owns. The desktop reads it; it does not keep a second copy. */
export type HostDelegation = {
  id: string;
  projectId: string;
  launchKey: string;
  fingerprint: string;
  ownerSession: string;
  childSession: string | null;
  generation: number;
  state: HostDelegationState;
  title: string;
  brief: string;
  harness: string;
  model: string;
  runtimeMode: string;
  startedBy: Initiator;
  status: HostDelegationStatus;
  result: string | null;
  error: string | null;
  errorClass: string | null;
  retryable: boolean;
  createdAt: number;
  updatedAt: number;
};

/** One thing that happened while a desktop may have been away. `seq` is the cursor. */
export type CatchUpEntry = {
  seq: number;
  projectId: string;
  delegationId: string;
  /** The chat the report goes back to. Empty when an older host did not record one. */
  ownerSession: string;
  kind: "started" | "finished" | "failed" | "cancelled";
  startedBy: Initiator;
  text: string;
  at: number;
};

export type CatchUpPage = { entries: CatchUpEntry[] };

/** A wake the host's classifier queued. Same shape the desktop queue already uses. */
export type HostWake = {
  id: string;
  projectId: string;
  ownerSession: string;
  seq: number;
  kind: string;
  key: string;
  delegationId: string | null;
  generation: number | null;
  title: string | null;
  text: string;
  delivery: "pending" | "queued" | "delivered" | "acknowledged" | "disposed";
  createdAt: number;
  updatedAt: number;
};
