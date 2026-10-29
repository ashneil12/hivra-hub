// r69 (PM's blind r67 (d)): the Hub's Being built listed "Tidy Today…" and "Tidy the inbox list" as Hub lead · Working a
// day after both sub-chats completed and were delivered: Ash OS's job never hears that this app's workers finished.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { jobRowsFinishedAt } from "../../monos/model/workerStuck";
import { workerOf } from "./liveJobs";
import { jobState, jobStateWord } from "./hubWork";
import { withStuckWorkers } from "./stuckJobs";
import type { HubJob, HubJobGroup } from "./types";

const MIN = 60_000;
const NOW = Date.parse("2026-10-29T05:40:00Z");
const group: HubJobGroup = { leadId: "hub-lead", leadName: "Hub lead", projectId: "monocode-hub", jobs: [] };
const job = (over: Partial<HubJob>): HubJob => ({
  id: "j1", projectId: "monocode-hub", title: "Tidy Today so needs-you stands out", lead: "hub-lead", leadName: "Hub lead", state: "working",
  reason: "1 working", startedAt: new Date(NOW - 9 * 60 * MIN).toISOString(), lastActiveAt: new Date(NOW - 9 * 60 * MIN).toISOString(),
  finishedAt: null, seen: false, sourceRef: "delegation:t-tidy", ...over,
});
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "hub-lead-chat", ownerMono: "hub-lead", batchId: null, parentId: null, rootId: id,
    childSession: `w-${id}`, requestId: id, generation: 1, project: "monocode-hub", title: "Tidy Today so needs-you stands out", brief: null, goal: null,
    askIds: [], state: "completed", errorClass: null, error: null, retryable: null, resetsAt: null, result: "done",
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - 9 * 60 * MIN, updatedAt: NOW - 9 * 60 * MIN + 15 * MIN,
    settledAt: NOW - 9 * 60 * MIN + 15 * MIN, log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  };
}

describe("r69 (d): a job whose workers are all done stops reading Working", () => {
  it("reads Done when every worker under it completed, by delegation or by ask", () => {
    const [w] = withStuckWorkers([workerOf(job({}), group, NOW)], [row("t-tidy")], NOW);
    expect(jobState(w)).toBe("done_unseen");
    expect(jobStateWord(w)).toBe("Done");
    const byAsk = job({ id: "j2", title: "Tidy the inbox list", sourceRef: "ask:a_inbox" });
    const [v] = withStuckWorkers([workerOf(byAsk, group, NOW)], [row("t-inbox", { askIds: ["a_inbox"] })], NOW);
    expect(jobStateWord(v)).toBe("Done");
  });

  it("keeps Working while any worker under it still runs or asks, and leaves a failure to the stuck rule", () => {
    expect(jobRowsFinishedAt("delegation:t-tidy", [row("t-tidy"), row("b", { parentId: "t-tidy", rootId: "t-tidy", state: "running", settledAt: null })])).toBeUndefined();
    expect(jobRowsFinishedAt("delegation:t-tidy", [row("t-tidy", { state: "question", settledAt: null })])).toBeUndefined();
    expect(jobRowsFinishedAt("delegation:t-tidy", [row("t-tidy", { state: "failed" })])).toBeUndefined();
    expect(jobRowsFinishedAt("delegation:t-tidy", [row("t-tidy", { state: "cancelled" })])).toBeUndefined();
    expect(jobRowsFinishedAt("delegation:t-none", [row("t-tidy")])).toBeUndefined();
    const [w] = withStuckWorkers([workerOf(job({}), group, NOW)], [row("t-tidy", { state: "running", settledAt: null })], NOW);
    expect(jobStateWord(w)).toBe("Working");
  });

  it("never overrides a job Ash OS has as checking or stuck, or one its Lead gave up on", () => {
    const [c] = withStuckWorkers([workerOf(job({ state: "checking" }), group, NOW)], [row("t-tidy")], NOW);
    expect(jobStateWord(c)).toBe("Checking");
    const [g] = withStuckWorkers([workerOf(job({ state: "lead_gave_up" }), group, NOW)], [row("t-tidy")], NOW);
    expect(jobStateWord(g)).toBe("Needs you");
  });

  it("Today's Being built leaves such a job out of its active list", async () => {
    const { readFileSync } = await import("node:fs");
    const surface = readFileSync(new URL("../ui/HubSurface.tsx", import.meta.url), "utf8");
    expect(surface).toContain('!(j.state === "working" && jobRowsFinishedAt(j.sourceRef, delegations) !== undefined)');
  });
});
