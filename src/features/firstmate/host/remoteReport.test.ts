// @vitest-environment happy-dom
// A remote result is one report in the chat that started it, and only after that chat has it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import type { CatchUpEntry } from "./types";
import {
  bindRemoteReports,
  deliverRemoteReports,
  placeRemoteReport,
  remoteReportMessage,
  setRemoteReportDelivery,
} from "./remoteReport";

const entry = (patch: Partial<CatchUpEntry> = {}): CatchUpEntry => ({
  seq: 4,
  projectId: "proj-1",
  delegationId: "d1",
  ownerSession: "owner-1",
  kind: "finished",
  startedBy: "person",
  text: "The change is in.",
  at: 1_000,
  ...patch,
});

beforeEach(() => {
  setRemoteReportDelivery(null);
});

describe("remote report", () => {
  it("says who started the work and uses one id per journal line", () => {
    expect(remoteReportMessage(entry()).text).toContain("You started this.");
    expect(remoteReportMessage(entry()).text).toContain("The change is in.");
    expect(remoteReportMessage(entry({ startedBy: "schedule" })).text).toContain("A schedule started this.");
    expect(remoteReportMessage(entry({ startedBy: "first-mate" })).text).toContain("The first mate started this.");
    expect(remoteReportMessage(entry()).monoSessionCompletion).toEqual({
      sessionId: "d1",
      title: "Host",
      status: "completed",
    });
    expect(remoteReportMessage(entry({ kind: "failed" })).monoSessionCompletion?.status).toBe("failed");
    expect(remoteReportMessage(entry({ kind: "cancelled" })).monoSessionCompletion?.status).toBe("cancelled");
    expect(remoteReportMessage(entry()).id).toBe("fm-remote-proj-1-4");
  });

  it("puts the report on that chat once, and refuses a chat that is not open", () => {
    const owner = { ...newSession("claude", "/tmp/app"), id: "owner-1" };
    const other = { ...newSession("claude", "/tmp/app"), id: "other" };
    const placed = placeRemoteReport([other, owner], entry());
    expect(placed.placed).toBe(true);
    expect(placed.sessions[1].queuedMessages?.[0].id).toBe("fm-remote-proj-1-4");
    const again = placeRemoteReport(placed.sessions, entry());
    expect(again.placed).toBe(true);
    expect(again.sessions[1].queuedMessages).toHaveLength(1);
    expect(placeRemoteReport([other], entry()).placed).toBe(false);
  });

  it("does not accept delivery when the chat cannot take the report", async () => {
    await expect(deliverRemoteReports([entry()])).resolves.toBe(false);
    const place = vi.fn(() => false);
    const stop = bindRemoteReports({
      isOrchestrator: () => false,
      isRemoving: () => false,
      ensureOpen: async () => true,
      place,
    });
    await expect(deliverRemoteReports([entry()])).resolves.toBe(false);
    expect(place).not.toHaveBeenCalled();
    stop();

    const open = vi.fn(async () => false);
    const stopOpen = bindRemoteReports({
      isOrchestrator: () => true,
      isRemoving: () => false,
      ensureOpen: open,
      place,
    });
    await expect(deliverRemoteReports([entry()])).resolves.toBe(false);
    expect(place).not.toHaveBeenCalled();
    stopOpen();

    const stopMissing = bindRemoteReports({
      isOrchestrator: () => true,
      isRemoving: () => false,
      ensureOpen: async () => true,
      place,
    });
    await expect(deliverRemoteReports([entry()])).resolves.toBe(false);
    expect(place).toHaveBeenCalledOnce();
    stopMissing();
    await expect(deliverRemoteReports([entry()])).resolves.toBe(false);
  });
});
