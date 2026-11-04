import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSessionLease } from "./lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "fm-lease-"));
  roots.push(directory);
  return join(directory, "locks");
}

describe("session lease", () => {
  it("lets one holder drive a session, and a second release is safe", () => {
    const directory = root();
    const first = acquireSessionLease("session-1", directory);
    expect(first).not.toBeNull();
    expect(acquireSessionLease("session-1", directory)).toBeNull();
    first!.release();
    first!.release();
    const second = acquireSessionLease("session-1", directory);
    expect(second).not.toBeNull();
    expect(readFileSync(join(directory, "session-1.lock"), "utf8")).toBe(String(process.pid));
    second!.release();
    expect(readFileSync(join(directory, "session-1.lock"), "utf8")).toBe("0");
  });

  it("creates the lock directory and refuses an unsafe id before any file exists", () => {
    const directory = root();
    expect(existsSync(directory)).toBe(false);
    expect(acquireSessionLease("abc", directory)).not.toBeNull();
    expect(existsSync(join(directory, "abc.lock"))).toBe(true);
    expect(() => acquireSessionLease("../etc", directory)).toThrow(/unsafe session id/);
    expect(() => acquireSessionLease("", directory)).toThrow(/unsafe session id/);
    expect(existsSync(join(directory, "..lock"))).toBe(false);
  });

  it("does not steal a live holder's file, and does take a dead one's", () => {
    const directory = root();
    const held = acquireSessionLease("seed", directory);
    held!.release();
    writeFileSync(join(directory, "heldbyother.lock"), String(process.ppid));
    expect(acquireSessionLease("heldbyother", directory)).toBeNull();
    writeFileSync(join(directory, "deadholder.lock"), "2147483647");
    const taken = acquireSessionLease("deadholder", directory);
    expect(taken).not.toBeNull();
    taken!.release();
  });
});
