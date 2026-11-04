import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostStore } from "../store";
import { FirstMateRecords, LaunchConflictError, launchFingerprint } from "./records";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function records(leaseMs = 15_000) {
  const directory = mkdtempSync(join(tmpdir(), "fm-records-"));
  const store = new HostStore(join(directory, "host.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { book: new FirstMateRecords(store, leaseMs), store };
}

const input = (now: number, patch: Record<string, string> = {}) => ({
  projectId: "project-1",
  launchKey: "launch-1",
  ownerSession: "owner-1",
  title: "Ship the fix",
  brief: "Change the copy.",
  harness: "codex",
  model: "codex:test",
  runtimeMode: "supervised",
  startedBy: "person" as const,
  now,
  ...patch,
  fingerprint: launchFingerprint({
    projectId: "project-1",
    ownerSession: "owner-1",
    title: patch.title ?? "Ship the fix",
    brief: patch.brief ?? "Change the copy.",
    harness: "codex",
    model: "codex:test",
    runtimeMode: "supervised",
    startedBy: "person",
  }),
});

describe("first mate records", () => {
  it("starts a launch once, adopts it when the lease expires, and conflicts on a different brief", () => {
    const { book, store } = records();
    const first = book.claim(input(1_000));
    expect(first.created).toBe(true);
    expect(first.start).toBe(true);

    const held = book.claim(input(1_001));
    expect(held.created).toBe(false);
    expect(held.start).toBe(false);
    expect(held.row.id).toBe(first.row.id);

    store.db.prepare("UPDATE fm_leases SET until_ms=0").run();
    const adopted = book.claim(input(1_002));
    expect(adopted.start).toBe(true);
    expect(adopted.created).toBe(false);
    expect(adopted.row.id).toBe(first.row.id);

    expect(() => book.claim(input(1_003, { brief: "A different change." }))).toThrow(LaunchConflictError);
    expect(book.list("project-1")).toHaveLength(1);
  });

  it("keeps one journal of a finished launch and does not start it again", () => {
    const { book } = records();
    const claimed = book.claim(input(2_000));
    book.releaseLaunchLease(claimed.row.launchKey, claimed.holder);
    const finished = book.finish(
      claimed.row.id,
      { state: "completed", status: "done", result: "The change is in.", error: null, errorClass: null, retryable: false },
      { kind: "finished", text: "The change is in." },
      [],
      2_100,
    );
    expect(finished?.state).toBe("completed");
    expect(book.finish(
      claimed.row.id,
      { state: "failed", status: "failed", result: null, error: "again", errorClass: null, retryable: false },
      { kind: "failed", text: "again" },
      [],
      2_200,
    )?.state).toBe("completed");

    const page = book.catchUp("project-1", 0);
    expect(page.map((entry) => entry.kind)).toEqual(["started", "finished"]);
    expect(page.every((entry) => entry.startedBy === "person")).toBe(true);
    expect(book.catchUp("project-1", page.at(-1)!.seq)).toEqual([]);

    const again = book.claim(input(2_300));
    expect(again.start).toBe(false);
    expect(again.row.id).toBe(claimed.row.id);
    expect(book.catchUp("project-1", 0)).toHaveLength(2);
  });
});
