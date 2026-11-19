// r51 on PM's r30h: a failed worker its Lead is done with is red (workerStuck.ts leadTurnOver), and Being built lists
// this app's own workers no Ash OS job stands for. Both feed the one list the rail chip, its panel and the red rows
// read. Critiquito on PM's 30h proof (pm-30h-lead-done-red-1512.png): Hivra showed two red rows and a grey one while the
// sidebar said "1 needs you". That exact mix must give a chip of 2.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import * as store from "../../monos/model/delegationStore";
import { stuckWorkers } from "../../monos/model/workerStuck";
import { beingBuiltJobRows, isNeedsYouRow, needsYouFor, needsYouPanel, needsYouRows } from "./needsYouRows";

const countFor = (rows: Parameters<typeof needsYouFor>[0], lead: string) => needsYouFor(rows, lead).length;
import type { HubJob, HubJobGroup } from "./types";
import type { AppWorkerWhere } from "./stuckJobs";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "hivra-chat", ownerMono: "hivra-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "hivra", title: `Job ${id}`, brief: null, goal: null, askIds: [],
    state: "failed", errorClass: null, error: "Stopped with an error.", retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000,
    settledAt: NOW - 60_000, log: [{ at: NOW - 60_000, by: "app", event: "settled", state: "failed" }],
    version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
const job = (id: string, sourceRef: string): HubJob =>
  ({ id, projectId: "hivra", title: `Ash OS ${id}`, lead: "hivra-lead", leadName: "Hivra lead", state: "working", reason: "",
     startedAt: iso(NOW - 600_000), lastActiveAt: iso(NOW - 60_000), finishedAt: null, seen: false, sourceRef }) as HubJob;
const where: AppWorkerWhere = { project: (r) => r.project ?? undefined, lead: (r) => ({ id: r.ownerMono ?? undefined, name: "Hivra lead" }) };
const setBusy = (ids: string[]) => store.setBusyChats(ids);

function lists(groups: HubJobGroup[], delegations: Delegation[]) {
  const rows = beingBuiltJobRows("hivra", groups, delegations, NOW, () => undefined, where);
  const list = needsYouRows(rows, stuckWorkers(delegations, NOW), () => "hivra");
  const lone = list.filter((r) => r.worker && r.projectId === "hivra").length;
  return { rows, list, beingBuiltRed: rows.flatMap((w) => [w, ...(w.parts ?? [])]).filter(isNeedsYouRow).length + lone };
}

beforeEach(() => store.resetDelegationStore());

// r61 (PM's blind D5 on r60): a plain failure its Lead is done with is no longer red (it gave Ash nothing to act on), so
// the same mix is all grey now; the chip, panel and rows still agree.
describe("r51 × r30h × r61: chip, panel and red rows agree", () => {
  it("Critiquito's mix on the 30h proof: the Lead-done failures stay grey now: chip 0, panel 0, rows 0", () => {
    setBusy([]); // the Lead's turn is over
    const delegations = [
      row("t1"), // under an Ash OS job; failed, delivered, Lead done: red
      row("app1"), // this app's own worker, no job: red
      row("app2", { delivery: "pending" }), // the failure hasn't reached the Lead yet: grey With Hivra lead
    ];
    const { rows, list, beingBuiltRed } = lists([{ leadId: "hivra-lead", leadName: "Hivra lead", projectId: "hivra", jobs: [job("j1", "delegation:t1")] }], delegations);
    expect(rows.map((w) => w.id).sort()).toEqual(["app:app1", "app:app2", "j1"]);
    expect(rows.filter(isNeedsYouRow).map((w) => w.id).sort()).toEqual([]);
    expect(countFor(list, "hivra-lead")).toBe(0);
    expect(needsYouPanel(needsYouFor(list, "hivra-lead")).count).toBe(0);
    expect(beingBuiltRed).toBe(0);
  });

  it("while the Lead's turn runs and after it ends they stay grey and count 0, chip = panel = rows", () => {
    const delegations = [row("t1"), row("app1"), row("app2", { delivery: "pending" })];
    const groups = [{ leadId: "hivra-lead", leadName: "Hivra lead", projectId: "hivra", jobs: [job("j1", "delegation:t1")] }];
    setBusy(["hivra-chat"]);
    expect(countFor(lists(groups, delegations).list, "hivra-lead")).toBe(0);
    setBusy([]);
    const after = lists(groups, delegations);
    expect(countFor(after.list, "hivra-lead")).toBe(after.beingBuiltRed);
    expect(needsYouPanel(needsYouFor(after.list, "hivra-lead")).count).toBe(0);
  });

  it("mixes every kind: a gave-up job and a credits worker are red; a Lead-done worker and the rest grey; the count is the red rows", () => {
    setBusy([]);
    const delegations = [row("done1"), row("credits", { errorClass: "billing", error: "Billing refused" }), row("grey", { delivery: "pending" }), row("run", { state: "running", settledAt: null, log: [] })];
    const gaveUp = { ...job("g1", "delegation:none"), state: "lead_gave_up", reason: "It still fails" } as HubJob;
    const { list, beingBuiltRed } = lists([{ leadId: "hivra-lead", leadName: "Hivra lead", projectId: "hivra", jobs: [gaveUp] }], delegations);
    expect(countFor(list, "hivra-lead")).toBe(2);
    expect(beingBuiltRed).toBe(2);
    expect(needsYouPanel(needsYouFor(list, "hivra-lead")).count).toBe(2);
  });
});
