// Critiquito on r30: Being built showed Hivra lead two red Needs you rows while the rail said "1 needs you". Both now
// come from one list: the rail's count for a Lead is its rows in it.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { isNeedsYouRow, needsYouCountFor, needsYouRows } from "./needsYouRows";
import type { Worker } from "./types";

const now = Date.now();
const row = (id: string, patch: Partial<Delegation> = {}): Delegation =>
  ({ id, ownerSession: "hivra-chat", ownerMono: "hivra-lead", rootId: id, childSession: `c-${id}`, state: "failed", errorClass: null,
    error: null, retryable: null, delivery: "pending", createdAt: now - 60_000, updatedAt: now, settledAt: now, log: [], ...patch }) as unknown as Delegation;
const stuck = (id: string, patch: Partial<Delegation> = {}): StuckWorker => ({ row: row(id, patch), kind: "failed", line: "", since: now, escalated: false, key: `k-${id}` });
const job = (id: string, patch: Partial<Worker> = {}): Worker =>
  ({ id, projectId: "hivra", who: "Hivra lead", kind: "job", doing: id, minutes: 1, steps: [], lead: "hivra-lead", ...patch }) as Worker;

describe("one list of red Needs you rows", () => {
  it("counts a Lead's gave-up job and its credits worker with no job row: two rows, '2 needs you'", () => {
    const gaveUp = job("j1", { stuck: "lead_gave_up", stuckReason: "It still fails" });
    const working = job("j2");
    const credits = stuck("w1", { errorClass: "billing" });
    const rows = needsYouRows([gaveUp, working], [credits], () => "hivra");
    expect(rows.map((r) => r.key)).toEqual(["job:j1", "worker:k-w1"]);
    expect(needsYouCountFor(rows, "hivra-lead")).toBe(2);
    expect(needsYouCountFor(rows, "exo-lead")).toBe(0);
  });

  it("never counts a worker twice: one its job row carries is that row", () => {
    const credits = stuck("w1", { errorClass: "billing" });
    const carried = job("j1", { stuck: "stuck", stuckWorker: credits });
    expect(isNeedsYouRow(carried)).toBe(true);
    expect(needsYouCountFor(needsYouRows([carried], [credits], () => "hivra"), "hivra-lead")).toBe(1);
  });

  it("leaves out what is grey: a worker its Lead has, a finished job", () => {
    const plain = stuck("w2", { error: "Claude exited with code 1", delivery: "delivered" });
    const rows = needsYouRows([job("j3", { stuck: "stuck", stuckWorker: plain }), job("j4", { stuck: "lead_gave_up", finishedAt: now })], [plain], () => "hivra");
    expect(rows).toEqual([]);
  });
});
