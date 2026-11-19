// A job's end reaches its ask (askJobs.ts; README gap D5): started while a job works, done with its proof when it passed
// and was accepted, back to heard with a note when it failed or was cancelled, never silently closed. A job covering
// several asks updates each. Late results, repeats and the other windows' words are never overwritten.
import { describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { jobProof, withJobs, type JobRow } from "./askJobs";
import { createAskStore } from "./askStore";
import { emptyAskDoc, isLedgerAskId, withChange as change, withHeard, type Ask, type AskDoc } from "./asks";

/** One change by someone's hand. A refusal is a test bug here, so it throws instead of returning a problem. */
function withChange(...args: Parameters<typeof change>): { doc: AskDoc; ask: Ask } {
  const out = change(...args);
  if ("problem" in out) throw new Error(out.problem);
  return out;
}

const T0 = 1_800_000_000_000;
const SEC = 1000;

/** A ledger holding one heard ask per quote, in one message. */
function ledger(...quotes: string[]): { doc: AskDoc; ids: string[] } {
  const doc = withHeard(emptyAskDoc(T0), {
    mateId: "mate",
    sessionId: "chat-1",
    blockId: "blk-aaaaaaaaaaaa",
    list: { asks: quotes.map((quote) => ({ quote, summary: quote, kind: "do" as const })), maybes: [] },
    by: "model",
    now: T0,
  });
  return { doc, ids: doc.asks.map((ask) => ask.id) };
}

const REPORT = JSON.stringify({ summary: "Saved rows keep their order now.", filesChanged: [], checks: [], evidence: [], openQuestions: [], selfAssessment: [], missing: [] });
const job = (id: string, askIds: string[], patch: Partial<JobRow> = {}): JobRow => ({ id, askIds, status: "working", title: "Fix the save bug", ...patch });
const passed = (id: string, askIds: string[], at: number, patch: Partial<JobRow> = {}): JobRow =>
  job(id, askIds, { status: "done", gateVerdict: "passed", report: REPORT, settledAt: at, updatedAt: at, ...patch });
const failed = (id: string, askIds: string[], at: number, patch: Partial<JobRow> = {}): JobRow =>
  job(id, askIds, { status: "failed", state: "failed", statusNotice: "The checks failed.", settledAt: at, updatedAt: at, ...patch });
const get = (doc: AskDoc, id: string): Ask => doc.asks.find((ask) => ask.id === id) as Ask;

describe("a job that is working", () => {
  it("takes the ask it carries to started, with its id kept on the ask and a plain note", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const next = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    expect(get(next, ids[0])).toMatchObject({ status: "started", note: "Handed to a worker: Fix the save bug", jobs: ["t-1"], updatedAt: T0 + SEC });
    expect(get(next, ids[0]).history.at(-1)).toMatchObject({ status: "started", by: "app" });
  });

  it("a job waiting on someone (needs you) or held for a usage limit (paused) is still working, not an end", () => {
    for (const status of ["needs-you", "paused"] as const) {
      const { doc, ids } = ledger("please fix the save bug on the settings page");
      const next = withJobs(doc, [job("t-1", [ids[0]], { status })], T0 + SEC);
      expect(get(next, ids[0]).status, status).toBe("started");
    }
    // Paused after it ended once, on a retry: the ask stays started, not sent back.
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const started = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    const held = withJobs(started, [job("t-1", [ids[0]], { status: "paused" })], T0 + 2 * SEC);
    expect(get(held, ids[0])).toMatchObject({ status: "started", note: "Handed to a worker: Fix the save bug" });
  });

  it("keeps what someone else said: an ask waiting on Ash stays waiting, a done or dropped one is not touched", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder", "rename the pricing heading to something shorter");
    let next = withChange(doc, ids[0], { status: "waiting", note: "which page?" }, "mate", T0 + SEC).doc;
    next = withChange(next, ids[1], { status: "done", proof: "answered in this chat" }, "mate", T0 + SEC).doc;
    next = withChange(next, ids[2], { status: "dropped" }, "ash", T0 + SEC).doc;
    const out = withJobs(next, ids.map((id, n) => job(`t-${n}`, [id])), T0 + 2 * SEC);
    expect(get(out, ids[0])).toMatchObject({ status: "waiting", note: "which page?", jobs: ["t-0"] });
    expect(get(out, ids[1]).status).toBe("done");
    expect(get(out, ids[2]).status).toBe("dropped");
    expect(get(out, ids[1]).jobs).toBeUndefined();
  });

  it("a maybe is the person's to settle: a job does not start it", () => {
    const doc = withHeard(emptyAskDoc(T0), {
      mateId: "mate",
      sessionId: "chat-1",
      blockId: "blk-aaaaaaaaaaaa",
      list: { asks: [], maybes: [{ quote: "can we get a nightly build going", summary: "nightly build", kind: "do" }] },
      by: "model",
      now: T0,
    });
    const out = withJobs(doc, [job("t-1", [doc.asks[0].id])], T0 + SEC);
    expect(out).toBe(doc);
  });
});

describe("a job that passed and was accepted", () => {
  it("closes its ask as done, with its gate verdict and report summary as the proof, by the app", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const running = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    const out = withJobs(running, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC);
    const ask = get(out, ids[0]);
    expect(ask).toMatchObject({ status: "done", proof: 'Job "Fix the save bug" finished, checks passed. Saved rows keep their order now.' });
    expect(ask.note).toBeUndefined();
    expect(ask.history.at(-1)).toMatchObject({ status: "done", by: "app" });
  });

  it("says so when the pass was partial: built but not tested, or accepted by its first mate without a pass", () => {
    for (const [notice, words] of [
      ["Built, not tested yet", "built, not tested yet"],
      ["Accepted without a pass: the diff is right", "accepted without a pass: the diff is right"],
    ] as const) {
      const { doc, ids } = ledger("please fix the save bug on the settings page");
      const running = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
      const out = withJobs(running, [passed("t-1", [ids[0]], T0 + 9 * SEC, { statusNotice: notice, gateVerdict: null })], T0 + 10 * SEC);
      expect(get(out, ids[0]).proof, notice).toContain(`finished, ${words}`);
    }
  });

  it("with no report block, the proof still names the job and what its checks said, and stays inside the proof limit", () => {
    expect(jobProof(passed("t-1", ["ask-1-x"], T0, { report: null, result: null }))).toBe('Job "Fix the save bug" finished, checks passed');
    expect(jobProof(passed("t-1", ["ask-1-x"], T0, { report: "not json", result: "It works. Then more words." }))).toBe('Job "Fix the save bug" finished, checks passed. It works.');
    expect(jobProof(passed("t-1", ["ask-1-x"], T0, { gateVerdict: null, report: null }))).toContain("no checks were needed");
    expect(jobProof(passed("t-1", ["ask-1-x"], T0, { report: JSON.stringify({ summary: "x".repeat(900), checks: [] }) })).length).toBeLessThanOrEqual(300);
  });

  it("a job covering several asks closes each", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder", "rename the pricing heading to something shorter");
    const running = withJobs(doc, [job("t-1", ids)], T0 + SEC);
    expect(running.asks.map((ask) => ask.status)).toEqual(["started", "started", "started"]);
    const out = withJobs(running, [passed("t-1", ids, T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(out.asks.map((ask) => ask.status)).toEqual(["done", "done", "done"]);
    for (const ask of out.asks) expect(ask.proof).toContain("checks passed");
  });

  it("an ask waiting on Ash stays waiting: the job's pass does not answer what it waits on", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const waiting = withChange(withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC), ids[0], { status: "waiting", note: "which page?" }, "mate", T0 + 2 * SEC).doc;
    const out = withJobs(waiting, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(get(out, ids[0])).toMatchObject({ status: "waiting", note: "which page?" });
  });
});

describe("a job that failed or was cancelled", () => {
  it("sends its ask back to heard with a note saying why, never closed", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const running = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    const out = withJobs(running, [failed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC);
    const ask = get(out, ids[0]);
    expect(ask.status).toBe("heard");
    expect(ask.note).toBe('Its job failed ("Fix the save bug"): The checks failed. Back on the list.');
    expect(ask.proof).toBeUndefined();
    expect(ask.history.at(-1)).toMatchObject({ status: "heard", by: "app", note: ask.note });
  });

  it("a cancelled job says it was cancelled, with its own words when the row has none", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const running = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    const out = withJobs(running, [failed("t-1", [ids[0]], T0 + 9 * SEC, { state: "cancelled", statusNotice: null })], T0 + 10 * SEC);
    expect(get(out, ids[0]).note).toBe('Its job was cancelled ("Fix the save bug"): it was stopped. Back on the list.');
  });

  it("a job covering several asks sends each back", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder");
    const running = withJobs(doc, [job("t-1", ids)], T0 + SEC);
    const out = withJobs(running, [failed("t-1", ids, T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(out.asks.map((ask) => ask.status)).toEqual(["heard", "heard"]);
    for (const ask of out.asks) expect(ask.note).toContain("Its job failed");
  });

  it("an ask nobody started, or one waiting on Ash, is left as it was", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder");
    const waiting = withChange(doc, ids[1], { status: "waiting", note: "which folder?" }, "mate", T0 + SEC).doc;
    const out = withJobs(waiting, [failed("t-1", ids, T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(get(out, ids[0])).toBe(get(waiting, ids[0]));
    expect(get(out, ids[1])).toMatchObject({ status: "waiting", note: "which folder?" });
  });

  it("a retry of the same job takes the ask back to started, and its pass then closes it", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    let next = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    next = withJobs(next, [failed("t-1", [ids[0]], T0 + 5 * SEC)], T0 + 6 * SEC);
    expect(get(next, ids[0]).status).toBe("heard");
    next = withJobs(next, [job("t-1", [ids[0]])], T0 + 7 * SEC);
    expect(get(next, ids[0])).toMatchObject({ status: "started", note: "Handed to a worker: Fix the save bug", jobs: ["t-1"] });
    next = withJobs(next, [passed("t-1", [ids[0]], T0 + 20 * SEC)], T0 + 21 * SEC);
    expect(get(next, ids[0]).status).toBe("done");
  });
});

describe("late results, repeats and other hands", () => {
  it("the same rows applied again change nothing: the same document, so nothing is written", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder");
    const running = withJobs(doc, [job("t-1", ids)], T0 + SEC);
    expect(withJobs(running, [job("t-1", ids)], T0 + 2 * SEC)).toBe(running);
    const done = withJobs(running, [passed("t-1", ids, T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(withJobs(done, [passed("t-1", ids, T0 + 9 * SEC)], T0 + 20 * SEC)).toBe(done);
    const back = withJobs(running, [failed("t-1", ids, T0 + 9 * SEC)], T0 + 10 * SEC);
    expect(withJobs(back, [failed("t-1", ids, T0 + 9 * SEC)], T0 + 20 * SEC)).toBe(back);
  });

  it("an ask Ash reopened after its job finished stays open: the old end is not applied again", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const done = withJobs(withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC), [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC);
    const reopened = withChange(done, ids[0], { status: "heard" }, "ash", T0 + 30 * SEC).doc;
    expect(withJobs(reopened, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 40 * SEC)).toBe(reopened);
  });

  it("a result that lands late does not overwrite what the first mate said after the job ended", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const running = withJobs(doc, [job("t-1", [ids[0]])], T0 + SEC);
    // The job ended at +9s; the first mate marked it waiting at +12s; the result is applied at +15s.
    const said = withChange(running, ids[0], { status: "waiting", note: "which page?" }, "mate", T0 + 12 * SEC).doc;
    expect(withJobs(said, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 15 * SEC)).toBe(said);
    expect(withJobs(said, [failed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 15 * SEC)).toBe(said);
    // The same when the later word is "started" (the first mate took it up again itself): the old end does not undo it.
    const again = withChange(running, ids[0], { status: "started", note: "picked it up myself" }, "mate", T0 + 12 * SEC).doc;
    expect(withJobs(again, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 15 * SEC)).toBe(again);
    expect(withJobs(again, [failed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 15 * SEC)).toBe(again);
  });

  it("Ash's dropped is never touched, by a pass or a failure", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const dropped = withChange(doc, ids[0], { status: "dropped" }, "ash", T0 + SEC).doc;
    expect(withJobs(dropped, [passed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC)).toBe(dropped);
    expect(withJobs(dropped, [failed("t-1", [ids[0]], T0 + 9 * SEC)], T0 + 10 * SEC)).toBe(dropped);
    expect(withJobs(dropped, [job("t-1", [ids[0]])], T0 + 10 * SEC)).toBe(dropped);
  });

  it("an ask another job still works on is left to that job; the last job to end decides", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const two = [job("t-1", [ids[0]]), job("t-2", [ids[0]], { title: "Add the test" })];
    const running = withJobs(doc, two, T0 + SEC);
    expect(get(running, ids[0]).jobs).toEqual(["t-1", "t-2"]);
    // One passed, the other still working: the ask stays started.
    const half = withJobs(running, [passed("t-1", [ids[0]], T0 + 9 * SEC), two[1]], T0 + 10 * SEC);
    expect(get(half, ids[0]).status).toBe("started");
    // The last to end passed: done, with that job's proof.
    const done = withJobs(half, [passed("t-1", [ids[0]], T0 + 9 * SEC), passed("t-2", [ids[0]], T0 + 20 * SEC, { title: "Add the test" })], T0 + 21 * SEC);
    expect(get(done, ids[0])).toMatchObject({ status: "done" });
    expect(get(done, ids[0]).proof).toContain('Job "Add the test"');
    // The last to end failed: back to heard, not closed on the earlier pass.
    const back = withJobs(half, [passed("t-1", [ids[0]], T0 + 9 * SEC), failed("t-2", [ids[0]], T0 + 20 * SEC, { title: "Add the test" })], T0 + 21 * SEC);
    expect(get(back, ids[0]).status).toBe("heard");
    expect(get(back, ids[0]).note).toContain('"Add the test"');
  });

  it("old Ash OS ids, ids with no ask, other shapes and rows with no shown status say nothing", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    const rows: JobRow[] = [
      job("t-1", ["a_1020save01"]),
      job("t-2", ["ask-99-zzzz"]),
      job("t-3", ["../../etc", "ask-", ""]),
      { id: "t-4", askIds: [ids[0]] },
      { id: "t-5", askIds: [ids[0]], status: "mystery" as unknown as JobRow["status"] },
    ];
    expect(withJobs(doc, rows, T0 + SEC)).toBe(doc);
  });

  it("keeps at most ten job ids on one ask, newest last", () => {
    const { doc, ids } = ledger("please fix the save bug on the settings page");
    let next = doc;
    for (let n = 0; n < 14; n += 1) {
      next = withJobs(next, [job(`t-${n}`, [ids[0]])], T0 + (2 * n + 1) * SEC);
      next = withJobs(next, [failed(`t-${n}`, [ids[0]], T0 + (2 * n + 2) * SEC)], T0 + (2 * n + 2) * SEC);
    }
    const jobs = get(next, ids[0]).jobs as string[];
    expect(jobs).toHaveLength(10);
    expect(jobs.at(-1)).toBe("t-13");
  });
});

describe("the ids a delegation may carry", () => {
  it("accepts the ledger's id shape and nothing else of it", () => {
    for (const ok of ["ask-5-abc123def456", "ask-12-", "ask-999999999-A1b2", "ask-1-x"]) expect(isLedgerAskId(ok), ok).toBe(true);
    for (const bad of ["ask-", "ask-x-abc", "ask--abc", "ask-5", "ask-5-abc-def", "ask-5-abc def", "ask-5-abcdefghijklm", "ask-1234567890-abc", "Ask-5-abc", "a_1020save01", "", "ask-5-ünï", "ask-5-../x"])
      expect(isLedgerAskId(bad), bad).toBe(false);
  });

  it("an id the ledger makes is an id a delegation accepts", () => {
    const { ids } = ledger("please fix the save bug on the settings page", "make the export remember the last folder");
    for (const id of ids) expect(isLedgerAskId(id), id).toBe(true);
  });
});

describe("through the store", () => {
  it("writes once, and applying the same rows again writes nothing", async () => {
    const disk = memoryDisk();
    const store = createAskStore(disk, () => T0 + 5 * SEC);
    await store.load();
    await store.hear({ mateId: "mate", sessionId: "chat-1", blockId: "blk-aaaaaaaaaaaa", list: { asks: [{ quote: "please fix the save bug on the settings page", summary: "x", kind: "do" }], maybes: [] }, by: "model", now: T0 });
    const id = store.doc().asks[0].id;
    await store.jobs([job("t-1", [id])]);
    const revision = store.doc().revision;
    expect(store.doc().asks[0].status).toBe("started");
    await store.jobs([job("t-1", [id])]);
    expect(store.doc().revision).toBe(revision);
    // A second window reading the disk sees the same ask.
    const other = createAskStore(disk, () => T0 + 6 * SEC);
    expect((await other.load()).asks[0]).toMatchObject({ status: "started", jobs: ["t-1"] });
  });

  it("two windows applying the same job end at once end with one done ask", async () => {
    const disk = memoryDisk();
    let clock = T0 + SEC;
    const a = createAskStore(disk, () => clock);
    const b = createAskStore(disk, () => clock);
    await a.load();
    await b.load();
    await a.hear({ mateId: "mate", sessionId: "chat-1", blockId: "blk-aaaaaaaaaaaa", list: { asks: [{ quote: "please fix the save bug on the settings page", summary: "x", kind: "do" }], maybes: [] }, by: "model", now: T0 });
    const id = a.doc().asks[0].id;
    await a.jobs([job("t-1", [id])]);
    clock = T0 + 20 * SEC;
    await Promise.all([a.jobs([passed("t-1", [id], T0 + 9 * SEC)]), b.jobs([passed("t-1", [id], T0 + 9 * SEC)])]);
    const doc = await createAskStore(disk, () => T0 + 30 * SEC).load();
    expect(doc.asks).toHaveLength(1);
    expect(doc.asks[0].status).toBe("done");
    expect(doc.asks[0].history.filter((step) => step.status === "done")).toHaveLength(1);
  });
});
