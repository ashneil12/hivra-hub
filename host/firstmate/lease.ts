// Translated from Puppetmaster's session_lease.py (MIT, Copyright (c) 2026 Cary).
// https://github.com/professorpalmer/Puppetmaster
//
// The original is an exclusive kernel lock beside the provider session: two workers
// must not resume the same native thread, and the kernel drops the lock if the
// holder dies. Node's flock is per-process on Linux, and both sides of a reconnect
// race are requests in the one host process, so a kernel lock would not stop them.
// This keeps the original's rules — unsafe id refused, non-blocking, null when a
// live holder has it, throw only when the lock cannot be created, release is safe
// to call twice — and holds the lease in this process as well. A dead pid counts
// as released, which is the crash the kernel lock covered.

import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** This process's held locks, keyed by lock path. A kernel flock would not see them. */
const held = new Map<string, number>();

export class SessionLease {
  private fd: number | null;

  constructor(
    private readonly path: string,
    fd: number,
  ) {
    this.fd = fd;
  }

  release(): void {
    const fd = this.fd;
    this.fd = null;
    if (fd === null) return;
    held.delete(this.path);
    try {
      closeSync(fd);
    } finally {
      // The file stays, as the original's lock file stays. The pid inside is
      // cleared so the next acquire does not treat a dead holder as live.
      try {
        const cleared = openSync(this.path, "r+");
        try {
          // A shorter pid must not leave the previous holder's tail behind.
          ftruncateSync(cleared, 0);
          writeSync(cleared, "0", 0);
        } finally {
          closeSync(cleared);
        }
      } catch {
        /* the directory may already be gone */
      }
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    // EPERM: the process exists but we may not signal it. Treat it as live.
    return code === "EPERM";
  }
}

/**
 * Lease a native session, or null when another live holder has it.
 * Throws only when the lock file cannot be created at all.
 */
export function acquireSessionLease(sessionId: string, root: string): SessionLease | null {
  if (!SAFE_ID.test(sessionId)) throw new Error(`unsafe session id ${JSON.stringify(sessionId)}`);
  const path = join(root, `${sessionId}.lock`);
  if (held.has(path)) return null;
  // Reserve before any file work so two requests in this process cannot both pass.
  held.set(path, -1);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 'a+' leaves the descriptor at the end, so read the path itself. A missing
    // file is an unheld lease, not an error (the original creates it).
    let existing = "";
    try {
      existing = readFileSync(path, "utf8").trim();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    const owner = Number(existing);
    if (pidAlive(owner) && owner !== process.pid) {
      held.delete(path);
      return null;
    }
    // 'a+' creates the file, but it is O_APPEND: on Linux a positioned write
    // then ignores the position and would leave the previous pid in front.
    closeSync(openSync(path, "a+"));
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, String(process.pid), 0);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    held.set(path, fd);
    return new SessionLease(path, fd);
  } catch (error) {
    held.delete(path);
    throw error;
  }
}
