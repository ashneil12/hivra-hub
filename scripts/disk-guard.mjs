#!/usr/bin/env node
// A disk floor for the heavy local commands (`npm run check:rust`, `hub:build`): refuse to start one when the home
// volume has less free space than the floor, instead of filling the disk halfway through a Rust build.
//
//   node scripts/disk-guard.mjs <what>           # exit 0 when there is room, 75 (try later) when there is not
//
// Floor: MONOCODE_DISK_FLOOR_GB (default 30). MONOCODE_DISK_FLOOR_GB=0 turns the floor off.
// On 10 Nov 2026 about 90 worktrees, each with its own 9-12 GB target/, filled the Mac to 127 MB free.

import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_FLOOR_GB = 30;
export const EXIT_NO_ROOM = 75;
const GB = 1024 ** 3;

/** The floor in GB from the environment: a non-negative number, else the default. */
export function floorGb(env = process.env) {
  const raw = env.MONOCODE_DISK_FLOOR_GB;
  if (raw == null || raw.trim() === "") return DEFAULT_FLOOR_GB;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FLOOR_GB;
}

/** Free bytes for an unprivileged user on the volume holding `dir`. */
export function freeBytes(dir = os.homedir(), statfs = fs.statfsSync) {
  const stats = statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Whether `what` may start: `{ ok, freeGb, floor, message }`. */
export function check(what, { env = process.env, free = () => freeBytes() } = {}) {
  const floor = floorGb(env);
  if (floor === 0) return { ok: true, freeGb: null, floor, message: null };
  let bytes;
  try {
    bytes = free();
  } catch {
    // A volume that can't be read is not a reason to stop work.
    return { ok: true, freeGb: null, floor, message: null };
  }
  const freeGb = bytes / GB;
  if (freeGb >= floor) return { ok: true, freeGb, floor, message: null };
  return {
    ok: false,
    freeGb,
    floor,
    message:
      `${what}: not started, ${freeGb.toFixed(1)} GB free is under the ${floor} GB floor. ` +
      "Free space first: npm run hub:clean (then -- --yes) reaps merged worktrees and finished build output. " +
      "MONOCODE_DISK_FLOOR_GB changes the floor (0 turns it off).",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const result = check(process.argv[2] || "this command");
  if (!result.ok) {
    console.error(result.message);
    process.exit(EXIT_NO_ROOM);
  }
}
