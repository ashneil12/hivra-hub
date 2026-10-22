// Critiquito on r30: Being built showed Hivra lead two red Needs you rows while the rail said "1 needs you". Both now
// come from one list: the rail's count for a Lead is its rows in it.
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { stuckOf, type StuckWorker } from "../../monos/model/workerStuck";
import { stuckWorkerChip } from "../../monos/model/stuckChip";
import { workerChip } from "./statusChip";
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

// PM's r30c proof (pm-30c-red-cases-1512.png): Being built showed Hivra lead three red rows (the login refused, out of
// retries, key rejected) while the rail said "2 needs you". Every r30c red reason feeds the one list the rail counts.
describe("the r30c red reasons all feed the one list", () => {
  const failedLog = (n: number) => Array.from({ length: n }, (_, i) => ({ at: now - (n - i) * 60_000, by: "app", event: "settled", state: "failed" }));
  const mk = (id: string, patch: Partial<Delegation>): StuckWorker => stuckOf(row(id, patch), now)!;
  const signedOut = mk("out", { errorClass: "auth", error: "The email sender refused the login. OAuth token has expired. Please run /login" });
  const outOfRetries = mk("oor", { error: "Claude exited with code 1", log: failedLog(4) as never });
  const keyRejected = mk("key", { error: "API Error: 401 Unauthorized: invalid x-api-key" });
  const refused = mk("ref", { errorClass: "provider_error", retryable: false, error: "API Error: 400 The request was refused under the usage policy" });
  const stalledGrey = mk("idle", { state: "running", stallKind: "idle", stallReason: "No output for 12 min" } as Partial<Delegation>);
  const firstCrash = mk("crash1", { error: "Claude exited with code 1", log: failedLog(1) as never });

  it("signed out, out of retries, key rejected and request refused are each one red row, and the count is the rows", () => {
    // PM's screen: two carried by job rows, the rest lone workers; a grey With <Lead> job and a Working one beside them.
    const jobs = [
      job("emails", { stuck: "stuck", stuckWorker: signedOut }),
      job("backup", { stuck: "sent_to_lead" as Worker["stuck"] }),
      job("deploy", { stuck: "stuck", stuckWorker: keyRejected }),
      job("signup", { stuck: "stuck", stuckWorker: stalledGrey }),
      job("welcome"),
    ];
    const all = [signedOut, outOfRetries, keyRejected, refused, firstCrash].filter(Boolean);
    const rows = needsYouRows(jobs, all, () => "hivra");
    expect(rows.map((r) => r.key).sort()).toEqual(["job:deploy", "job:emails", "worker:" + outOfRetries.key, "worker:" + refused.key].sort());
    for (const r of rows) {
      const chip = r.job ? workerChip(r.job) : stuckWorkerChip(r.worker!, "Hivra lead");
      expect(chip).toMatchObject({ word: "Needs you", tone: "red" });
    }
    expect(needsYouCountFor(rows, "hivra-lead")).toBe(rows.length);
    expect(needsYouCountFor(rows, "hivra-lead")).toBe(4);
  });
});
