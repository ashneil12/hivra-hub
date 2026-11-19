// Model-based property tests for the ask ledger's real store (askStore.ts, on asks.ts's reducers) -- formal/asks/README.md,
// part B.2. Random interleavings of the steps an ask goes through, run against the REAL store on the in-memory disk the
// app's own tests use (two stores on one disk behave like two windows), and against a small reference model written
// here from the rules in docs/specs/mono-chat-memory.md section 6 and asks.ts's comments, not from the reducers' code.
// After every step the store must equal the model, and no ask may be lost.
//
// The steps: extract (Ash's message is heard: the rules' quick reading or the model's list), delegate (the first mate
// marks it started), complete (done with proof), fail (the worker failed: the first mate marks it waiting on Ash), a
// worker crash (nothing is written; the daily check must still name it), the person's taps (done, drop, reopen, settle a
// maybe), a first mate trying to drop one (refused), an app restart (a new store on the same disk), a chat's history
// compaction (the fresh session is handed every open ask) and a duplicate delivery (the same hearing again).
//
// And the job-finish steps (sc-18, askJobs.ts; README gap D5): a delegation row carries the ask's ledger id. A job starts
// (the ask goes to started), a job ends (passed: the ask is done with the job's proof; failed or cancelled: back to heard
// with a note, never silently closed) and the rows are applied again (the feed refreshes them on every change). Their model
// is written from the rule, not from askJobs.ts: an end applies to an ask nobody has moved since, an ask waiting on Ash stays
// waiting, Ash's "dropped" and a done ask are never touched, and a maybe is the person's to settle.
//
// The last property is gap A1 (README): an ask Ash adds by hand under a message must survive the model's reading of that
// message landing. It failed until sc-17-ask-fixes (the test used to assert the failure and the shortest run, `extract,
// add by hand, extract`); it is now the plain property.
import { fc } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { askDigest, DIGEST_STARTED_MS, openAsksNote } from "./askNotes";
import type { JobRow } from "./askJobs";
import { createAskStore, type AskStore } from "./askStore";
import { ASK_STATUSES, openAsksFor, type Ask, type AskStatus, type HeardAsk } from "./asks";

// ---- The world: two messages of Ash's, three asks each ------------------------------------------------------------------

const BLOCKS = ["blk-a", "blk-b"] as const;
// Distinct, long, and none inside another, so the ledger's "same ask" folding never applies across them.
const QUOTES: readonly (readonly string[])[] = [
  [
    "can you fix the invoice export so it stops dropping the last row",
    "please add a test for the weekly report email before the launch",
    "make sure the onboarding tour only shows once per install",
  ],
  [
    "we need to rename the pricing page heading to something shorter",
    "could you write up what changed in the backup job schedule",
    "also check why the search box is slow on the first load",
  ],
];
const SLOTS = [0, 1, 2, 3, 4, 5] as const;
const blockOf = (slot: number) => (slot < 3 ? 0 : 1);
const quoteOf = (slot: number) => QUOTES[blockOf(slot)][slot % 3];
const keyOf = (slot: number) => `${BLOCKS[blockOf(slot)]}|${slot % 3}`;
const MATE = "mate";
const SESSION = "chat-1";
const DAY = 24 * 60 * 60 * 1000;

type MRow = { st: AskStatus; touched: boolean; note?: string; proof?: string };
type Model = {
  rows: Map<string, MRow>;
  tries: Map<string, number>;
  /** Every row that was ever changed by anyone: none may disappear. */
  everTouched: Set<string>;
  /** The last hearing, for a duplicate delivery. */
  lastHear?: HearArgs;
  /** A worker crashed under a started ask. */
  crashed: Set<string>;
  /** The delegations that carry an ask's ledger id, by slot, oldest first. */
  jobs: Map<number, MJob[]>;
  jobSeq: number;
};
/** One delegation row, as the model keeps it: open, or ended by passing, failing or being cancelled. */
type MJob = { id: string; state: "open" | "passed" | "failed" | "cancelled"; settledAt?: number };
type Real = { disk: ReturnType<typeof memoryDisk>; store: AskStore; clock: { t: number } };
type HearArgs = { block: 0 | 1; asks: number[]; maybes: number[]; by: "rules" | "model" };

const newModel = (): Model => ({ rows: new Map(), tries: new Map(), everTouched: new Set(), crashed: new Set(), jobs: new Map(), jobSeq: 0 });
async function newReal(): Promise<Real> {
  const clock = { t: 1_800_000_000_000 };
  const disk = memoryDisk();
  const store = createAskStore(disk, () => clock.t);
  await store.load();
  return { disk, store, clock };
}
const tick = (real: Real) => {
  real.clock.t += 1000;
  return real.clock.t;
};

const heardAsk = (slot: number): HeardAsk => ({ quote: quoteOf(slot), summary: quoteOf(slot).slice(0, 40), kind: "do" });
const rowFor = (real: Real, slot: number): Ask | undefined => real.store.doc().asks.find((ask) => ask.quote === quoteOf(slot));

// ---- The reference model ------------------------------------------------------------------------------------------------

function modelHear(m: Model, h: HearArgs): void {
  const block = BLOCKS[h.block];
  // The message's rows nobody has touched are replaced by the new list; a touched row stays as it is.
  for (const [key, row] of [...m.rows]) if (key.startsWith(`${block}|`) && !row.touched && (row.st === "heard" || row.st === "maybe")) m.rows.delete(key);
  for (const s of h.asks) if (!m.rows.has(keyOf(h.block * 3 + s))) m.rows.set(keyOf(h.block * 3 + s), { st: "heard", touched: false });
  for (const s of h.maybes) if (!m.rows.has(keyOf(h.block * 3 + s))) m.rows.set(keyOf(h.block * 3 + s), { st: "maybe", touched: false });
  m.tries.set(block, (m.tries.get(block) ?? 0) + 1);
  m.lastHear = h;
}

type Change = { status?: AskStatus; note?: string; proof?: string };
function modelChange(row: MRow, change: Change, by: "ash" | "mate"): { problem: true } | { row: MRow; changed: boolean } {
  if (by === "mate") {
    if (change.status === "dropped") return { problem: true };
    if (change.status === "done" && !(change.proof ?? row.proof)) return { problem: true };
    if (change.status === "waiting" && !(change.note ?? row.note)) return { problem: true };
    if (change.status === "maybe") return { problem: true };
    if (row.st === "dropped") return { problem: true };
  }
  const note = change.note === undefined ? row.note : change.note || undefined;
  const proof = change.proof === undefined ? row.proof : change.proof || undefined;
  const st = change.status ?? row.st;
  const changed = st !== row.st || note !== row.note || proof !== row.proof;
  return changed ? { row: { st, note, proof, touched: true }, changed } : { row, changed };
}

// ---- What must hold after every step ------------------------------------------------------------------------------------

function snapshotReal(real: Real): string[] {
  return real.store
    .doc()
    .asks.map((ask) => {
      const slot = SLOTS.find((s) => quoteOf(s) === ask.quote);
      return `${slot === undefined ? `?${ask.quote}` : keyOf(slot)} ${ask.status} note=${ask.note ?? ""} proof=${ask.proof ?? ""} touched=${ask.history.length > 1}`;
    })
    .sort();
}
const snapshotModel = (m: Model): string[] =>
  [...m.rows]
    .map(([key, row]) => `${key} ${row.st} note=${row.note ?? ""} proof=${row.proof ?? ""} touched=${row.touched}`)
    .sort();

function assertInvariants(m: Model, real: Real, where: string): void {
  const doc = real.store.doc();
  // The store is the model.
  expect(snapshotReal(real), where).toEqual(snapshotModel(m));
  // Every ask is in exactly one known state.
  for (const ask of doc.asks) expect(ASK_STATUSES, `${where}: ${ask.id}`).toContain(ask.status);
  expect(new Set(doc.asks.map((ask) => ask.id)).size, `${where}: ids`).toBe(doc.asks.length);
  expect(new Set(doc.asks.map((ask) => ask.n)).size, `${where}: numbers`).toBe(doc.asks.length);
  expect(new Set(doc.asks.map((ask) => ask.quote)).size, `${where}: one row per ask`).toBe(doc.asks.length);
  for (const ask of doc.asks) expect(doc.next, `${where}: next number`).toBeGreaterThan(ask.n);
  // No ask that was ever touched has gone.
  for (const key of m.everTouched) expect(m.rows.has(key), `${where}: lost ${key}`).toBe(true);
  // The hearing marks match.
  for (const block of BLOCKS) expect(doc.heard[block]?.tries ?? 0, `${where}: tries ${block}`).toBe(m.tries.get(block) ?? 0);
}

// ---- The steps ----------------------------------------------------------------------------------------------------------

type Cmd = fc.AsyncCommand<Model, Real>;

class Hear implements Cmd {
  constructor(readonly h: HearArgs) {}
  check = () => true;
  async run(m: Model, real: Real) {
    modelHear(m, this.h);
    await real.store.hear({
      mateId: MATE,
      sessionId: SESSION,
      blockId: BLOCKS[this.h.block],
      list: { asks: this.h.asks.map((s) => heardAsk(this.h.block * 3 + s)), maybes: this.h.maybes.map((s) => heardAsk(this.h.block * 3 + s)) },
      by: this.h.by,
      now: tick(real),
    });
    assertInvariants(m, real, this.toString());
  }
  toString = () => `extract(${BLOCKS[this.h.block]}, asks=[${this.h.asks}], maybes=[${this.h.maybes}], by=${this.h.by})`;
}

/** The same hearing delivered again: a second window, a retry, the model's reading arriving after the rules'. */
class DuplicateDelivery implements Cmd {
  check = (m: Readonly<Model>) => !!m.lastHear;
  async run(m: Model, real: Real) {
    const h = m.lastHear as HearArgs;
    const before = new Set(m.rows.keys());
    modelHear(m, h);
    await real.store.hear({
      mateId: MATE,
      sessionId: SESSION,
      blockId: BLOCKS[h.block],
      list: { asks: h.asks.map((s) => heardAsk(h.block * 3 + s)), maybes: h.maybes.map((s) => heardAsk(h.block * 3 + s)) },
      by: h.by,
      now: tick(real),
    });
    assertInvariants(m, real, this.toString());
    // Delivered twice, it still holds the same asks: nothing doubled, nothing gone that was there.
    for (const key of before) expect(m.rows.has(key), `${this.toString()}: ${key}`).toBe(true);
  }
  toString = () => "duplicate delivery of the last extract";
}

type Mate = "delegate" | "complete" | "fail";
class MateMarks implements Cmd {
  constructor(
    readonly slot: number,
    readonly what: Mate,
  ) {}
  check = (m: Readonly<Model>) => m.rows.has(keyOf(this.slot));
  async run(m: Model, real: Real) {
    const change: Change =
      this.what === "delegate"
        ? { status: "started", note: "handed to a worker" }
        : this.what === "complete"
          ? { status: "done", proof: "answered in this chat" }
          : { status: "waiting", note: "the worker failed, needs your call" };
    const row = m.rows.get(keyOf(this.slot)) as MRow;
    const out = modelChange(row, change, "mate");
    const ask = rowFor(real, this.slot) as Ask;
    const result = await real.store.change(ask.id, change, "mate");
    if ("problem" in out) expect("problem" in result, this.toString()).toBe(true);
    else {
      expect("ask" in result, this.toString()).toBe(true);
      m.rows.set(keyOf(this.slot), out.row);
      if (out.changed) m.everTouched.add(keyOf(this.slot));
    }
    assertInvariants(m, real, this.toString());
  }
  toString = () => `${this.what}(slot ${this.slot})`;
}

/** The first mate tries to drop an ask: only the person can. The ask must be exactly as it was. */
class MateTriesToDrop implements Cmd {
  constructor(readonly slot: number) {}
  check = (m: Readonly<Model>) => m.rows.has(keyOf(this.slot));
  async run(m: Model, real: Real) {
    const ask = rowFor(real, this.slot) as Ask;
    const result = await real.store.change(ask.id, { status: "dropped" }, "mate");
    expect("problem" in result, this.toString()).toBe(true);
    assertInvariants(m, real, this.toString());
  }
  toString = () => `the first mate tries to drop (slot ${this.slot})`;
}

type Tap = "done" | "drop" | "reopen" | "settle";
class PersonTaps implements Cmd {
  constructor(
    readonly slot: number,
    readonly tap: Tap,
  ) {}
  check = (m: Readonly<Model>) => m.rows.has(keyOf(this.slot));
  async run(m: Model, real: Real) {
    const status: AskStatus = this.tap === "done" ? "done" : this.tap === "drop" ? "dropped" : "heard";
    const row = m.rows.get(keyOf(this.slot)) as MRow;
    const out = modelChange(row, { status }, "ash");
    if ("problem" in out) throw new Error("the person is never refused");
    const ask = rowFor(real, this.slot) as Ask;
    const result = await real.store.change(ask.id, { status }, "ash");
    expect("ask" in result, this.toString()).toBe(true);
    m.rows.set(keyOf(this.slot), out.row);
    if (out.changed) m.everTouched.add(keyOf(this.slot));
    assertInvariants(m, real, this.toString());
  }
  toString = () => `the person taps ${this.tap} (slot ${this.slot})`;
}

/** A worker dies under a started ask. Nothing is written. Three days on, the daily check must name it. */
class WorkerCrash implements Cmd {
  constructor(readonly slot: number) {}
  check = (m: Readonly<Model>) => m.rows.get(keyOf(this.slot))?.st === "started";
  async run(m: Model, real: Real) {
    const before = snapshotReal(real);
    m.crashed.add(keyOf(this.slot));
    expect(snapshotReal(real)).toEqual(before);
    const later = real.clock.t + DIGEST_STARTED_MS + DAY;
    const digest = askDigest(real.store.doc(), MATE, "app", later);
    const ask = rowFor(real, this.slot) as Ask;
    expect(digest?.message.text, `${this.toString()}: the daily check names ask ${ask.n}`).toContain(`ask ${ask.n}`);
    assertInvariants(m, real, this.toString());
  }
  toString = () => `a worker crashes under slot ${this.slot}`;
}

/** The app restarts: a new store reads what the last one wrote. */
class Restart implements Cmd {
  check = () => true;
  async run(m: Model, real: Real) {
    const before = snapshotReal(real);
    const heardBefore = JSON.stringify(real.store.doc().heard);
    real.store = createAskStore(real.disk, () => real.clock.t);
    await real.store.load();
    expect(snapshotReal(real)).toEqual(before);
    expect(JSON.stringify(real.store.doc().heard)).toBe(heardBefore);
    assertInvariants(m, real, this.toString());
  }
  toString = () => "the app restarts";
}

/** The chat's history is compacted: the fresh session is handed every open ask (askNotes.ts openAsksNote). */
class Compact implements Cmd {
  check = () => true;
  async run(m: Model, real: Real) {
    const before = snapshotReal(real);
    const note = openAsksNote(real.store.doc(), MATE, "app");
    const open = openAsksFor(real.store.doc(), MATE);
    if (open.length) {
      expect(note, `${this.toString()}: a note`).toBeTruthy();
      for (const ask of open) expect(note, `${this.toString()}: ask ${ask.n}`).toContain(`"${ask.quote}"`);
    } else expect(note).toBeUndefined();
    // A "maybe" is the person's to settle; it is not in front of the first mate.
    for (const ask of real.store.doc().asks) if (ask.status === "maybe") expect(note ?? "").not.toContain(`ask ${ask.n}:`);
    expect(snapshotReal(real)).toEqual(before);
    assertInvariants(m, real, this.toString());
  }
  toString = () => "the chat's history is compacted";
}

// ---- The job-finish steps (askJobs.ts) ---------------------------------------------------------------------------------------

const JOB_TITLE = "Fix the save bug";
const JOB_SUMMARY = "Saved rows keep their order.";
const REPORT = JSON.stringify({ summary: JOB_SUMMARY, filesChanged: [], checks: [], evidence: [], openQuestions: [], selfAssessment: [], missing: [] });
/** What the rule says the ask reads after each outcome (written out, not taken from askJobs.ts). */
const START_NOTE = `Handed to a worker: ${JOB_TITLE}`;
const PASS_PROOF = `Job "${JOB_TITLE}" finished, checks passed. ${JOB_SUMMARY}`;
const backNote = (job: MJob) =>
  job.state === "cancelled" ? `Its job was cancelled ("${JOB_TITLE}"): it was stopped. Back on the list.` : `Its job failed ("${JOB_TITLE}"): The checks failed. Back on the list.`;

/** The delegation rows as the feed shows them, each carrying the ledger id of its slot's ask. */
function jobRows(m: Model, real: Real): JobRow[] {
  return [...m.jobs].flatMap(([slot, list]) => {
    const ask = rowFor(real, slot);
    if (!ask) return [];
    return list.map(
      (job): JobRow => ({
        id: job.id,
        askIds: [ask.id],
        title: JOB_TITLE,
        status: job.state === "open" ? "working" : job.state === "passed" ? "done" : "failed",
        state: job.state === "open" ? "running" : job.state === "passed" ? "completed" : job.state,
        gateVerdict: job.state === "passed" ? "passed" : null,
        report: job.state === "passed" ? REPORT : null,
        statusNotice: job.state === "failed" ? "The checks failed." : null,
        settledAt: job.settledAt ?? null,
        updatedAt: job.settledAt ?? 0,
      }),
    );
  });
}

/** A job that is working takes an ask nobody started to started. Every other state of the ask is someone's word and stays. */
const modelWorking = (row: MRow): MRow => (row.st === "heard" ? { st: "started", note: START_NOTE, proof: row.proof, touched: true } : row);

/**
 * A job that ended, applied to an ask nobody has moved since. Passed: an ask not started or started is done with the job's
 * proof (one waiting on Ash stays waiting). Failed or cancelled: only an ask the job had started goes back, with a note.
 * A done ask, Ash's dropped and a maybe are never touched.
 */
function modelEnded(row: MRow, job: MJob): MRow {
  if (job.state === "passed") return row.st === "heard" || row.st === "started" ? { st: "done", note: undefined, proof: PASS_PROOF, touched: true } : row;
  return row.st === "started" ? { st: "heard", note: backNote(job), proof: row.proof, touched: true } : row;
}

/** Every pass over the rows: a working job starts its ask. An ended job was applied when it ended and is not applied again. */
function modelApplyRows(m: Model): void {
  for (const [slot, list] of m.jobs) {
    const key = keyOf(slot);
    const row = m.rows.get(key);
    if (!row || !list.some((job) => job.state === "open")) continue;
    const next = modelWorking(row);
    if (next !== row) {
      m.rows.set(key, next);
      m.everTouched.add(key);
    }
  }
}

const hasOpenJob = (m: Readonly<Model>, slot: number) => (m.jobs.get(slot) ?? []).some((job) => job.state === "open");

/** A delegation that carries the ask's id starts. A maybe is the person's to settle first, so no job is made for one. */
class JobStarts implements Cmd {
  constructor(readonly slot: number) {}
  check = (m: Readonly<Model>) => {
    const row = m.rows.get(keyOf(this.slot));
    return !!row && row.st !== "maybe" && !hasOpenJob(m, this.slot);
  };
  async run(m: Model, real: Real) {
    m.jobs.set(this.slot, [...(m.jobs.get(this.slot) ?? []), { id: `job-${(m.jobSeq += 1)}`, state: "open" }]);
    await real.store.jobs(jobRows(m, real));
    modelApplyRows(m);
    assertInvariants(m, real, this.toString());
  }
  toString = () => `a job starts on slot ${this.slot}`;
}

type Ending = "passed" | "failed" | "cancelled";
/** The job on an ask ends. The row settles a moment after the last thing anyone did, and the app applies it. */
class JobEnds implements Cmd {
  constructor(
    readonly slot: number,
    readonly how: Ending,
  ) {}
  check = (m: Readonly<Model>) => hasOpenJob(m, this.slot);
  async run(m: Model, real: Real) {
    const list = m.jobs.get(this.slot) as MJob[];
    const job = list.find((item) => item.state === "open") as MJob;
    job.state = this.how;
    job.settledAt = tick(real);
    const key = keyOf(this.slot);
    const before = m.rows.get(key) as MRow;
    await real.store.jobs(jobRows(m, real));
    const next = modelEnded(before, job);
    if (next !== before) {
      m.rows.set(key, next);
      m.everTouched.add(key);
    }
    modelApplyRows(m);
    // An ended job never closes an ask unless it passed, and a job that failed never leaves its ask unmarked.
    const after = rowFor(real, this.slot) as Ask;
    if (this.how !== "passed" && before.st !== "done") expect(after.status, `${this.toString()}: a failed job never closes an ask`).not.toBe("done");
    if (this.how !== "passed" && before.st === "started") {
      expect(after.status, this.toString()).toBe("heard");
      expect(after.note, `${this.toString()}: back with a note`).toContain("Its job");
    }
    if (before.st === "dropped") expect(after.status, `${this.toString()}: Ash's dropped is his`).toBe("dropped");
    assertInvariants(m, real, this.toString());
  }
  toString = () => `the job on slot ${this.slot} ${this.how === "passed" ? "passes" : this.how === "failed" ? "fails" : "is cancelled"}`;
}

/**
 * After a job ended, someone moves the ask (Ash reopens it, or the first mate takes it up again) and the feed then delivers
 * the same rows again, the old end still among them. The ask is as that last hand left it: the end is not applied again.
 */
class MovedAfterEnd implements Cmd {
  constructor(
    readonly slot: number,
    readonly by: "ash" | "mate",
  ) {}
  check = (m: Readonly<Model>) => {
    const last = (m.jobs.get(this.slot) ?? []).at(-1);
    return !!m.rows.get(keyOf(this.slot)) && !!last && last.state !== "open";
  };
  async run(m: Model, real: Real) {
    tick(real);
    const key = keyOf(this.slot);
    const row = m.rows.get(key) as MRow;
    const change: Change = this.by === "ash" ? { status: "heard" } : { status: "started", note: "taking it up again myself" };
    const out = modelChange(row, change, this.by);
    const result = await real.store.change((rowFor(real, this.slot) as Ask).id, change, this.by);
    if ("problem" in out) expect("problem" in result, this.toString()).toBe(true);
    else {
      m.rows.set(key, out.row);
      if (out.changed) m.everTouched.add(key);
    }
    await real.store.jobs(jobRows(m, real));
    modelApplyRows(m);
    assertInvariants(m, real, this.toString());
  }
  toString = () => `${this.by === "ash" ? "Ash reopens" : "the first mate takes up again"} slot ${this.slot} after its job ended, then the rows are applied again`;
}

/** The feed refreshes: the same rows are applied again. Nothing that was applied is applied twice. */
class RowsAppliedAgain implements Cmd {
  check = (m: Readonly<Model>) => m.jobs.size > 0;
  async run(m: Model, real: Real) {
    await real.store.jobs(jobRows(m, real));
    modelApplyRows(m);
    assertInvariants(m, real, this.toString());
    // And once more straight after: a second pass over the same rows writes nothing.
    const revision = real.store.doc().revision;
    await real.store.jobs(jobRows(m, real));
    expect(real.store.doc().revision, `${this.toString()}: the second pass wrote`).toBe(revision);
  }
  toString = () => "the same delegation rows are applied again";
}

const subset = fc.subarray([0, 1, 2]);
const hearArb = fc
  .record({ block: fc.constantFrom<0 | 1>(0, 1), asks: subset, maybes: subset, by: fc.constantFrom<"rules" | "model">("rules", "model") })
  .map((r) => ({ ...r, maybes: r.maybes.filter((s) => !r.asks.includes(s)) }));
const slotArb = fc.constantFrom(...SLOTS);

const supported = [
  hearArb.map((h) => new Hear(h)),
  fc.constant(new DuplicateDelivery()),
  fc.tuple(slotArb, fc.constantFrom<Mate>("delegate", "complete", "fail")).map(([s, what]) => new MateMarks(s, what)),
  slotArb.map((s) => new MateTriesToDrop(s)),
  fc.tuple(slotArb, fc.constantFrom<Tap>("done", "drop", "reopen", "settle")).map(([s, tap]) => new PersonTaps(s, tap)),
  slotArb.map((s) => new WorkerCrash(s)),
  fc.constant(new Restart()),
  fc.constant(new Compact()),
  slotArb.map((s) => new JobStarts(s)),
  fc.tuple(slotArb, fc.constantFrom<Ending>("passed", "failed", "cancelled")).map(([s, how]) => new JobEnds(s, how)),
  fc.constant(new RowsAppliedAgain()),
  fc.tuple(slotArb, fc.constantFrom<"ash" | "mate">("ash", "mate")).map(([s, by]) => new MovedAfterEnd(s, by)),
];

describe("the ask ledger's real store, against a reference model", () => {
  it("after every step the store equals the model and no ask is lost (random interleavings)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(supported, { maxCommands: 30 }), async (cmds) => {
        await fc.asyncModelRun(async () => ({ model: newModel(), real: await newReal() }), cmds);
      }),
      { numRuns: 200 },
    );
  });

  // The job-finish rules, as fixed traces too: random runs reach a late end or a reopened ask only now and then, so each rule
  // the model states has a run that goes straight at it (broken one at a time, each of these fails).
  const hearAll = () => new Hear({ block: 0, asks: [0, 1, 2], maybes: [], by: "model" });
  it.each([
    ["a pass applied again after Ash reopened the ask does not close it", () => [hearAll(), new JobStarts(0), new JobEnds(0, "passed"), new MovedAfterEnd(0, "ash")]],
    ["a failure applied again after the first mate took the ask up itself does not send it back", () => [hearAll(), new JobStarts(0), new JobEnds(0, "failed"), new MovedAfterEnd(0, "mate")]],
    ["a cancelled job sends a started ask back with a note, and the same rows applied again write nothing", () => [hearAll(), new JobStarts(1), new JobEnds(1, "cancelled"), new RowsAppliedAgain()]],
    ["a job that passes while the ask waits on Ash leaves it waiting", () => [hearAll(), new MateMarks(2, "fail"), new JobStarts(2), new JobEnds(2, "passed"), new RowsAppliedAgain()]],
    ["Ash's drop is his: neither the start nor the end of a job touches it", () => [hearAll(), new PersonTaps(0, "drop"), new JobStarts(0), new JobEnds(0, "passed"), new RowsAppliedAgain()]],
    ["a done ask is not touched by a job that fails afterwards", () => [hearAll(), new MateMarks(0, "complete"), new JobStarts(0), new JobEnds(0, "failed"), new RowsAppliedAgain()]],
    ["a maybe is Ash's to settle: no job is made for it, and once he settles it a job takes it on", () => [new Hear({ block: 0, asks: [], maybes: [0], by: "rules" }), new JobStarts(0), new PersonTaps(0, "settle"), new JobStarts(0), new JobEnds(0, "passed")]],
    ["a second job on the same ask: a failure after an earlier pass sends it back, the next start takes it up again, its pass closes it", () => [hearAll(), new JobStarts(0), new JobEnds(0, "passed"), new PersonTaps(0, "reopen"), new JobStarts(0), new JobEnds(0, "failed"), new JobStarts(0), new JobEnds(0, "passed")]],
  ])("%s", async (_name, make) => {
    await fc.asyncModelRun(async () => ({ model: newModel(), real: await newReal() }), make());
  });

  it("two windows hearing the same message at once end with one copy of each ask, and none lost", async () => {
    await fc.assert(
      fc.asyncProperty(hearArb, fc.constantFrom<"rules" | "model">("rules", "model"), async (h, by2) => {
        const real = await newReal();
        const second = createAskStore(real.disk, () => real.clock.t);
        await second.load();
        const list = { asks: h.asks.map((s) => heardAsk(h.block * 3 + s)), maybes: h.maybes.map((s) => heardAsk(h.block * 3 + s)) };
        const input = { mateId: MATE, sessionId: SESSION, blockId: BLOCKS[h.block], list, now: real.clock.t };
        await Promise.all([real.store.hear({ ...input, by: h.by }), second.hear({ ...input, by: by2 })]);
        const fresh = createAskStore(real.disk, () => real.clock.t);
        const doc = await fresh.load();
        expect(doc.asks.map((ask) => ask.quote).sort()).toEqual([...h.asks, ...h.maybes].map((s) => quoteOf(h.block * 3 + s)).sort());
        expect(doc.heard[BLOCKS[h.block]]?.tries).toBe(2);
      }),
      { numRuns: 100 },
    );
  });

  it("two windows changing different asks at once both land", async () => {
    const real = await newReal();
    const second = createAskStore(real.disk, () => real.clock.t);
    await real.store.hear({ mateId: MATE, sessionId: SESSION, blockId: BLOCKS[0], list: { asks: [0, 1, 2].map(heardAsk), maybes: [] }, by: "model", now: tick(real) });
    await second.load();
    const [a, b] = [rowFor(real, 0) as Ask, rowFor(real, 1) as Ask];
    await Promise.all([real.store.change(a.id, { status: "done", proof: "answered in this chat" }, "mate"), second.change(b.id, { status: "dropped" }, "ash")]);
    const doc = await createAskStore(real.disk, () => real.clock.t).load();
    expect(doc.asks.find((ask) => ask.quote === quoteOf(0))?.status).toBe("done");
    expect(doc.asks.find((ask) => ask.quote === quoteOf(1))?.status).toBe("dropped");
    expect(doc.asks.find((ask) => ask.quote === quoteOf(2))?.status).toBe("heard");
  });
});

// ---- Gap A1: an ask added by hand is thrown away when the model's reading lands ------------------------------------------

type GapModel = { added: Set<string>; /** Messages whose receipt shows: the ledger holds a row for them. */ shown: Set<number> };
type GapCmd = fc.AsyncCommand<GapModel, Real>;

/** Ash taps "Add one that was missed" under a message (AskReceipt.tsx AddAsk -> store.add), which needs a receipt to tap it on. */
class AddByHand implements GapCmd {
  constructor(readonly block: 0 | 1) {}
  check = (m: Readonly<GapModel>) => m.shown.has(this.block);
  async run(m: GapModel, real: Real) {
    const text = `a missed ask that Ash added by hand under ${BLOCKS[this.block]} about the settings page`;
    await real.store.add({ mateId: MATE, sessionId: SESSION, blockId: BLOCKS[this.block], text });
    m.added.add(text);
    expect(real.store.doc().asks.some((ask) => ask.quote === text), "the added ask is on the ledger right after").toBe(true);
  }
  toString = () => `Ash adds an ask by hand under ${BLOCKS[this.block]}`;
}

/** A hearing of a message (the quick reading, or the model's list landing). Nothing Ash added may be lost by it. */
class HearKeepsHandAdded implements GapCmd {
  constructor(readonly h: HearArgs) {}
  check = () => true;
  async run(m: GapModel, real: Real) {
    await real.store.hear({
      mateId: MATE,
      sessionId: SESSION,
      blockId: BLOCKS[this.h.block],
      list: { asks: this.h.asks.map((s) => heardAsk(this.h.block * 3 + s)), maybes: this.h.maybes.map((s) => heardAsk(this.h.block * 3 + s)) },
      by: this.h.by,
      now: tick(real),
    });
    for (const text of m.added) expect(real.store.doc().asks.some((ask) => ask.quote === text), `still on the ledger: "${text}"`).toBe(true);
    if (real.store.doc().asks.some((ask) => ask.blockId === BLOCKS[this.h.block])) m.shown.add(this.h.block);
    else m.shown.delete(this.h.block);
  }
  toString = () => `extract(${BLOCKS[this.h.block]}, asks=[${this.h.asks}], maybes=[${this.h.maybes}], by=${this.h.by})`;
}

// FLIPPED by sc-17-ask-fixes (gap A1). This test used to assert that the property FAILS and shrinks to
// `extract, add by hand, extract` (seed 20261113). asks.ts withHeard now replaces only rows a hearing wrote, so the
// property passes: the same property, the same generators, asserted to hold.
describe("gap A1 (fixed): an ask Ash adds by hand under a message", () => {
  const property = fc.asyncProperty(
    fc.commands([hearArb.map((h) => new HearKeepsHandAdded(h)), fc.constantFrom<0 | 1>(0, 1).map((b) => new AddByHand(b))], { maxCommands: 6 }),
    async (cmds) => {
      await fc.asyncModelRun(async () => ({ model: { added: new Set<string>(), shown: new Set<number>() }, real: await newReal() }), cmds);
    },
  );

  it("survives every hearing of its message (random interleavings)", async () => {
    await fc.assert(property, { numRuns: 500 });
  });

  it("the run that used to break it (seed 20261113) now passes", async () => {
    await fc.assert(property, { seed: 20261113, numRuns: 500 });
  });
});
