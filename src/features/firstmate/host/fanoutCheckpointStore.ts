// Hivra WP-172: the Tauri side of a fan-out's checkpoint (src-tauri/src/fanout_checkpoint.rs). Every read goes through
// parseCheckpoint, so a row the app cannot read is none at all; the store answers by owner, so one chat never sees
// another chat's plans.
import { invoke } from "@tauri-apps/api/core";
import { parseCheckpoint, type FanoutCheckpoint } from "../model/fanoutCheckpoint";

/** This window's name for the leases it takes: one per window, kept for the window's life. */
let holder: string | undefined;
export function windowHolder(): string {
  if (holder === undefined) {
    holder = globalThis.crypto?.randomUUID?.() ?? `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
  return holder;
}

export type FanoutCheckpointStore = {
  /** Writes the plan if its revision is newer than the stored one. False when a newer copy is already there. */
  save(owner: string, checkpoint: FanoutCheckpoint): Promise<boolean>;
  /** The owner's unsettled plans, newest first. */
  list(owner: string): Promise<FanoutCheckpoint[]>;
  /** Drops one plan. */
  remove(owner: string, id: string): Promise<boolean>;
  /** Takes the plan's lease for this window when it is free or has run out. False when another window holds it. */
  acquire(owner: string, id: string, holder: string): Promise<boolean>;
  /** Extends a lease this window holds. False when it was taken over or released. */
  renew(owner: string, id: string, holder: string): Promise<boolean>;
  /** Gives the lease up, if this window still holds it. */
  release(owner: string, id: string, holder: string): Promise<boolean>;
};

export const tauriFanoutCheckpoints: FanoutCheckpointStore = {
  save: (owner, checkpoint) =>
    invoke<boolean>("fanout_checkpoint_save", {
      owner,
      id: checkpoint.id,
      revision: checkpoint.revision,
      body: checkpoint,
    }),
  list: async (owner) => {
    const rows = await invoke<unknown>("fanout_checkpoint_list", { owner });
    if (!Array.isArray(rows)) return [];
    return rows.map(parseCheckpoint).filter((cp): cp is FanoutCheckpoint => cp !== null);
  },
  remove: (owner, id) => invoke<boolean>("fanout_checkpoint_remove", { owner, id }),
  acquire: (owner, id, holder) => invoke<boolean>("fanout_lease_acquire", { owner, id, holder }),
  renew: (owner, id, holder) => invoke<boolean>("fanout_lease_renew", { owner, id, holder }),
  release: (owner, id, holder) => invoke<boolean>("fanout_lease_release", { owner, id, holder }),
};
