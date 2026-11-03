// Hivra WP-10: the worker's typed final report (src-tauri/src/firstmate/report.rs parses it when the row settles).
//
// A worker ends with this block, then its self-review (monos/model/workerReview.ts). The parsed report is on the row as
// JSON (`Delegation.report`). Its opinion of its own work is kept under `selfAssessment` and never counts as evidence.

/** The block every worker's rules ask for, word for word what report.rs reads. */
export const WORKER_REPORT_SHAPE = `## Report
Summary: what changed, in a sentence or two
Files changed:
- each file you changed
Checks:
- each command you ran: passed, failed or not run (the count)
Evidence:
- links, files or commits someone else can look at
Open questions:
- none, or each question`;

export type CheckOutcome = "passed" | "failed" | "not-run";

/** report.rs's WorkerReport, as stored on the row. */
export type WorkerReport = {
  summary: string | null;
  filesChanged: string[];
  checks: { command: string; outcome: CheckOutcome; detail: string | null }[];
  evidence: string[];
  openQuestions: string[];
  /** What the worker thinks of its own work: recorded, never evidence. */
  selfAssessment: string[];
  /** The parts it left out, or ["report"] when it had no report block. */
  missing: string[];
};

/** The row's stored report, or undefined when there is none or it can't be read. */
export function storedReport(json: string | null | undefined): WorkerReport | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as WorkerReport;
    return value && Array.isArray(value.checks) ? value : undefined;
  } catch {
    return undefined;
  }
}
