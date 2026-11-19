// A job's end reaches its ask (README gap D5). A delegation carries the ids of the ledger asks it covers (`asks` on
// delegate_task / delegate_tasks, the `askIds` of its row). This file turns the rows into ledger changes, in one pure
// step the store applies in a single revision-checked write (askStore.ts `jobs`):
//
//  - a job that is working, or waiting on someone, takes its ask to "started" and keeps its id on the ask;
//  - a job that passed and was accepted (the row's shown status is "done": gates passed, no gates apply, or its first mate
//    accepted it) closes the ask as done, with its gate verdict and report summary as the proof;
//  - a job that failed or was cancelled sends the ask back to "heard" with a note, so it is never silently closed;
//  - a job held for a usage limit ("paused") is not an end: the ask stays started. A timeout is not a final failure.
//
// It reads the row's own shown status (firstmate/status.rs): never works one out from the state.
//
// Safe to run again and again, from the rows as they stand: an end is applied only to an ask that has not moved since the
// job settled (so a late result never overwrites what Ash or the first mate said later, a reopened ask stays open, and a
// failed job's ask is not sent back twice), and an ask another job still works on is left to that job. Ash's "dropped" and
// an ask already done are never touched.
import type { Delegation } from "../../monos/model/delegations";
import { storedReport } from "../../firstmate/model/report";
import { isLedgerAskId, isOpen, JOBS_PER_ASK, oneLine, PROOF_MAX, NOTE_MAX, withChange, type Ask, type AskDoc } from "./asks";

/** What this reads of a delegation row. */
export type JobRow = Pick<Delegation, "id" | "askIds"> &
  Partial<Pick<Delegation, "status" | "state" | "title" | "statusNotice" | "gateVerdict" | "report" | "result" | "settledAt" | "updatedAt">>;

type Phase = "open" | "passed" | "ended";

function phaseOf(row: JobRow): Phase | undefined {
  switch (row.status) {
    case "working":
    case "needs-you":
    case "paused":
      return "open";
    case "done":
      return "passed";
    case "failed":
      return "ended";
    default:
      // A row from an older build with no shown status says nothing.
      return undefined;
  }
}

function endedAt(row: JobRow): number | undefined {
  for (const value of [row.settledAt, row.updatedAt]) if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

function clip(value: string, max: number): string {
  const line = oneLine(value);
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What shows a finished job did its work, in one line: its checks' verdict, then the report's own summary. */
export function jobProof(row: JobRow): string {
  // The row's own notice says it when the pass was partial: "Built, not tested yet", "Accepted without a pass: why".
  const notice = oneLine(row.statusNotice ?? "");
  const verdict = notice !== "" ? notice.replace(/^./, (c) => c.toLowerCase()) : row.gateVerdict === "passed" ? "checks passed" : "no checks were needed";
  const report = storedReport(row.report);
  const summary = oneLine(report?.summary ?? "") || oneLine(row.result ?? "").split(/(?<=[.!?])\s/)[0] || "";
  const title = oneLine(row.title ?? "");
  const head = `${title ? `Job "${clip(title, 60)}"` : "Its job"} finished, ${verdict}`;
  return clip(summary ? `${head}. ${summary}` : head, PROOF_MAX);
}

function failureNote(row: JobRow): string {
  const reason = (oneLine(row.statusNotice ?? "") || (row.state === "cancelled" ? "it was stopped" : "it stopped with an error")).replace(/[.!?\s]+$/, "");
  const title = oneLine(row.title ?? "");
  const lead = row.state === "cancelled" ? "Its job was cancelled" : "Its job failed";
  return clip(`${lead}${title ? ` ("${clip(title, 50)}")` : ""}: ${reason}. Back on the list.`, NOTE_MAX);
}

function working(row: JobRow): string {
  const title = oneLine(row.title ?? "");
  return clip(title ? `Handed to a worker: ${title}` : "Handed to a worker", NOTE_MAX);
}

function withJobIds(doc: AskDoc, id: string, ids: readonly string[]): AskDoc {
  const ask = doc.asks.find((item) => item.id === id);
  if (!ask) return doc;
  const have = ask.jobs ?? [];
  const fresh = ids.filter((job) => !have.includes(job));
  if (!fresh.length) return doc;
  const jobs = [...have, ...fresh].slice(-JOBS_PER_ASK);
  return { ...doc, asks: doc.asks.map((item) => (item.id === id ? { ...item, jobs } : item)) };
}

function settleAsk(doc: AskDoc, ask: Ask, rows: readonly JobRow[], now: number): AskDoc {
  if (ask.status === "dropped" || ask.status === "done" || ask.status === "maybe") return doc;
  const open = rows.filter((row) => phaseOf(row) === "open");
  if (open.length) {
    // A job is on it. Someone else's word on the ask ("waiting on Ash") is kept; only an ask nobody started becomes started.
    const ids = open.map((row) => row.id);
    if (ask.status !== "heard") return withJobIds(doc, ask.id, ids);
    const out = withChange(doc, ask.id, { status: "started", note: working(open[0]) }, "app", now);
    return withJobIds("problem" in out ? doc : out.doc, ask.id, ids);
  }
  // Every job on it has ended: the last to end speaks, if the ask has not moved since.
  const last = rows
    .map((row) => ({ row, at: endedAt(row) }))
    .filter((entry): entry is { row: JobRow; at: number } => entry.at !== undefined)
    .sort((a, b) => b.at - a.at)[0];
  if (!last || last.at <= ask.updatedAt) return doc;
  if (phaseOf(last.row) === "passed") {
    // An ask waiting on Ash stays waiting: the job's pass does not answer what it waits on.
    if (ask.status === "waiting") return doc;
    const out = withChange(doc, ask.id, { status: "done", proof: jobProof(last.row), note: "" }, "app", now);
    return withJobIds("problem" in out ? doc : out.doc, ask.id, [last.row.id]);
  }
  // Failed or cancelled. Only an ask the job had started goes back; one nobody started, or one waiting on Ash, is as it was.
  if (ask.status !== "started") return doc;
  const out = withChange(doc, ask.id, { status: "heard", note: failureNote(last.row) }, "app", now);
  return withJobIds("problem" in out ? doc : out.doc, ask.id, [last.row.id]);
}

/**
 * The ledger with every delegation row's effect on the asks it carries. Returns the same document when nothing changes,
 * so the store writes nothing.
 */
export function withJobs(doc: AskDoc, rows: readonly JobRow[], now: number): AskDoc {
  const byAsk = new Map<string, JobRow[]>();
  for (const row of rows) {
    if (!phaseOf(row)) continue;
    for (const id of new Set(row.askIds ?? [])) {
      if (!isLedgerAskId(id)) continue;
      byAsk.set(id, [...(byAsk.get(id) ?? []), row]);
    }
  }
  if (!byAsk.size) return doc;
  let next = doc;
  for (const [id, covering] of byAsk) {
    const ask = next.asks.find((item) => item.id === id);
    if (ask && isOpen(ask)) next = settleAsk(next, ask, covering, now);
  }
  return next;
}
