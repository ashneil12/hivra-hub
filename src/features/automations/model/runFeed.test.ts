import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../activity/model/activity";
import { collectRunPages, mergeRunPages, sessionIdFromLink, visibleRuns } from "./runFeed";

function entry(partial: Partial<ActivityEntry> & Pick<ActivityEntry, "id" | "kind" | "summary">): ActivityEntry {
  return {
    id: partial.id,
    seq: partial.seq ?? 1,
    kind: partial.kind,
    actor: { role: "app" },
    initiator: { role: "app" },
    project: partial.project ?? "/work/project",
    target: partial.target ?? "morning/run-1",
    summary: partial.summary,
    link: partial.link ?? "",
    at: partial.at ?? 1,
  };
}

describe("run feed", () => {
  it("merges the three kinds newest first and drops a repeated id", () => {
    const started = entry({
      id: "s",
      kind: "automation.started",
      summary: "Morning audit. Started by the 9:00 schedule.",
      at: 3,
      seq: 1,
    });
    const finished = entry({
      id: "f",
      kind: "automation.completed",
      summary: "Morning audit. Finished. Started by the 9:00 schedule.",
      at: 2,
      seq: 2,
    });
    const failed = entry({
      id: "x",
      kind: "automation.failed",
      summary: "Inbox. Failed: the Claude login has expired.",
      at: 2,
      seq: 9,
      target: "inbox/run-2",
    });
    const merged = mergeRunPages([
      { entries: [finished, started], next: null },
      null,
      { entries: [failed, finished] },
      { entries: [entry({ id: "other", kind: "git.push", summary: "no" })] },
    ]);
    expect(merged.map((row) => row.id)).toEqual(["s", "x", "f"]);
  });

  it("filters by automation and by result", () => {
    const rows = [
      entry({ id: "s", kind: "automation.started", summary: "start", target: "morning/run-1" }),
      entry({
        id: "f",
        kind: "automation.completed",
        summary: "done",
        target: "morning/run-1",
        link: "session:chat-1",
      }),
      entry({
        id: "x",
        kind: "automation.failed",
        summary: "failed",
        target: "inbox/run-2",
      }),
    ];
    expect(visibleRuns(rows, { automationId: "inbox" }).map((row) => row.id)).toEqual(["x"]);
    expect(visibleRuns(rows, { result: "finished" }).map((row) => row.id)).toEqual(["f"]);
    expect(
      visibleRuns(rows, { automationId: "morning", result: "started" }).map((row) => row.id),
    ).toEqual(["s"]);
    expect(visibleRuns(rows, { automationId: "missing" })).toEqual([]);
    expect(sessionIdFromLink("session:chat-1")).toBe("chat-1");
    expect(sessionIdFromLink("https://example.com")).toBe("");
    expect(sessionIdFromLink("session:")).toBe("");
  });

  it("follows an older page and stops when the load is no longer current", async () => {
    const older = entry({
      id: "old",
      kind: "automation.started",
      summary: "Older.",
      at: 1,
      seq: 1,
    });
    const newer = entry({
      id: "new",
      kind: "automation.started",
      summary: "Newer.",
      at: 2,
      seq: 2,
    });
    const calls: (string | undefined)[] = [];
    const merged = await collectRunPages(async (kind, before) => {
      calls.push(before ? `${kind}:${before.seq}` : kind);
      if (kind !== "automation.started") return { entries: [], next: null };
      if (!before) return { entries: [newer], next: { at: newer.at, seq: newer.seq } };
      return { entries: [older], next: null };
    });
    expect(merged.map((row) => row.id)).toEqual(["new", "old"]);
    expect(calls).toContain("automation.started:2");

    let stopped = false;
    const partial = await collectRunPages(async () => {
      stopped = true;
      return { entries: [newer], next: { at: newer.at, seq: newer.seq } };
    }, () => stopped);
    expect(partial.map((row) => row.id)).toEqual(["new"]);
  });

  it("does not read an older page again once that run is already held", async () => {
    const older = entry({
      id: "old",
      kind: "automation.started",
      summary: "Older.",
      at: 1,
      seq: 1,
    });
    const newer = entry({
      id: "new",
      kind: "automation.started",
      summary: "Newer.",
      at: 2,
      seq: 2,
    });
    const ancient = entry({
      id: "ancient",
      kind: "automation.started",
      summary: "Ancient.",
      at: 0,
      seq: 0,
    });
    const calls: string[] = [];
    const merged = await collectRunPages(
      async (kind, before) => {
        calls.push(before ? `${kind}:${before.seq}` : kind);
        if (kind !== "automation.started") return { entries: [], next: null };
        if (!before) {
          return { entries: [newer], next: { at: newer.at, seq: newer.seq } };
        }
        if (before.seq === newer.seq) {
          return { entries: [older], next: { at: older.at, seq: older.seq } };
        }
        return { entries: [ancient], next: null };
      },
      () => false,
      [older],
    );
    expect(merged.map((row) => row.id)).toEqual(["new", "old"]);
    expect(calls).toContain("automation.started:2");
    expect(calls).not.toContain("automation.started:1");
  });

  it("stops at the first page when that page already contains a held run", async () => {
    const older = entry({
      id: "old",
      kind: "automation.completed",
      summary: "Older.",
      at: 1,
      seq: 1,
    });
    const newer = entry({
      id: "new",
      kind: "automation.completed",
      summary: "Newer.",
      at: 2,
      seq: 2,
    });
    const calls: string[] = [];
    const merged = await collectRunPages(
      async (kind, before) => {
        calls.push(before ? `${kind}:${before.seq}` : kind);
        if (kind !== "automation.completed") return { entries: [], next: null };
        return { entries: [newer, older], next: { at: older.at, seq: older.seq } };
      },
      () => false,
      [older],
    );
    expect(merged.map((row) => row.id)).toEqual(["new", "old"]);
    expect(calls.some((call) => call.includes(":"))).toBe(false);
  });
});
