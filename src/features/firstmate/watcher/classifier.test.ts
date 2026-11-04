// Hivra WP-11's "Done when", classifier side: a test for each wake kind, the once-per-stretch stall notice, the
// 20-minute silence stop, and approvals and questions never counting as silence.
import { describe, expect, it } from "vitest";
import { classify, queuedWakes, SILENCE_MS, type Decision, type RowFacts, type WatchEvent } from "./classifier";
import { PROVIDER_STALL_PREFIX, type Presence, type WorkerLook } from "./stall";

const MIN = 60_000;

const row = (over: Partial<RowFacts> = {}): RowFacts => ({
  id: "t1",
  ownerSession: "lead",
  childSession: "w1",
  generation: 1,
  state: "running",
  title: "Fix the save bug",
  ...over,
});
const busy = (over: Partial<WorkerLook> = {}): WorkerLook => ({
  busy: true,
  asking: false,
  queued: false,
  limited: false,
  resumeStopped: false,
  steps: 3,
  ...over,
});
const presence = (lastChangeAt: number): Presence => ({ watchedSince: 0, lastChangeAt, lastProgressAt: lastChangeAt, steps: 3 });
const look = (r: RowFacts, l: WorkerLook, p: Presence, extra: Partial<Extract<WatchEvent, { kind: "look" }>> = {}): WatchEvent => ({
  kind: "look",
  row: r,
  look: l,
  presence: p,
  waitsOnWorkers: false,
  ...extra,
});
const wakes = (decisions: Decision[]) => decisions.flatMap((d) => (d.kind === "wake" ? [d.wake] : []));
const kinds = (decisions: Decision[]) => decisions.map((d) => d.kind);

describe("row changes", () => {
  it("a worker done wakes its first mate through its report", () => {
    const [w] = wakes(classify({ kind: "row", before: row(), row: row({ state: "completed", status: "done" }) }, 0));
    expect(w).toMatchObject({ kind: "worker-done", route: "report", ownerSession: "lead", key: "report:t1:1" });
  });

  it("done only once its gates pass: still checking is records only, a failed gate is a failure", () => {
    expect(kinds(classify({ kind: "row", before: row(), row: row({ state: "completed", status: "working", gateVerdict: "pending" }) }, 0))).toEqual(["record"]);
    const [w] = wakes(classify({ kind: "row", before: row({ state: "completed", status: "working", gateVerdict: "pending" }), row: row({ state: "completed", status: "failed", gateVerdict: "failed" }) }, 0));
    expect(w).toMatchObject({ kind: "worker-failed", route: "report" });
  });

  it("a worker that failed wakes its first mate; a usage-limit pause and a stop do not", () => {
    expect(wakes(classify({ kind: "row", before: row(), row: row({ state: "failed", status: "failed", error: "Claude exited" }) }, 0))[0]).toMatchObject({
      kind: "worker-failed",
      text: '"Fix the save bug" failed: Claude exited',
    });
    expect(kinds(classify({ kind: "row", before: row(), row: row({ state: "failed", status: "paused" }) }, 0))).toEqual(["record"]);
    expect(kinds(classify({ kind: "row", before: row(), row: row({ state: "cancelled", status: "failed" }) }, 0))).toEqual(["record"]);
  });

  it("the same settled row again changes nothing", () => {
    const done = row({ state: "completed", status: "done" });
    expect(kinds(classify({ kind: "row", before: done, row: done }, 0))).toEqual(["record"]);
  });

  it("a worker asking its first mate wakes it through the question; one passed on to the person does not", () => {
    const asking = row({ state: "question", pendingQuestion: "Which save slot?" });
    expect(wakes(classify({ kind: "row", before: row(), row: asking }, 0))[0]).toMatchObject({ kind: "worker-asking", route: "question" });
    expect(kinds(classify({ kind: "row", before: asking, row: asking }, 0))).toEqual(["record"]);
    expect(kinds(classify({ kind: "row", before: asking, row: { ...asking, questionOwner: "person" } }, 0))).toEqual(["record"]);
  });

  it("a worker saying it can't finish wakes its first mate through the queue, once; the first mate's own block does not", () => {
    const blocked = row({ stallKind: "blocked", stallReason: "needs a key", log: [{ event: "stalled", kind: "blocked", by: "self:w1" }] });
    const decided = classify({ kind: "row", before: row(), row: blocked }, 0);
    expect(queuedWakes(decided)).toEqual([expect.objectContaining({ kind: "worker-blocked", key: "blocked:t1:1" })]);
    expect(queuedWakes(decided)[0].text).toContain("needs a key");
    expect(kinds(classify({ kind: "row", before: blocked, row: blocked }, 0))).toEqual(["record"]);
    const byOwner = row({ stallKind: "blocked", log: [{ event: "stalled", kind: "blocked", by: "owner:lead" }] });
    expect(kinds(classify({ kind: "row", before: row(), row: byOwner }, 0))).toEqual(["record"]);
  });

  it("routine moves are records only", () => {
    expect(kinds(classify({ kind: "row", before: null, row: row() }, 0))).toEqual(["record"]);
  });
});

describe("looks at a running worker", () => {
  it("a moving worker is records only", () => {
    expect(kinds(classify(look(row(), busy(), presence(10 * MIN)), 11 * MIN))).toEqual(["record"]);
  });

  it("a quiet worker: the stall is recorded and its first mate told, keyed by the silent stretch", () => {
    const decided = classify(look(row(), busy(), presence(10 * MIN)), 17 * MIN);
    expect(kinds(decided)).toEqual(["stall", "wake"]);
    const [w] = queuedWakes(decided);
    expect(w).toMatchObject({ kind: "stall", ownerSession: "lead", key: `stall:t1:1:${10 * MIN}` });
    expect(w.text).toContain("quiet for 7 minutes");
    expect(w.text).toContain("20 minutes");
  });

  it("once per silent stretch: every later look in the same stretch says the same key; only activity re-arms it", () => {
    const stalled = row({ stallKind: "quiet", stallReason: "", stalledAt: 10 * MIN });
    const later = queuedWakes(classify(look(stalled, busy(), presence(10 * MIN)), 15 * MIN + 10 * MIN));
    expect(later.map((w) => w.key)).toEqual([`stall:t1:1:${10 * MIN}`]);
    // It talks again at 26 min: the stall clears, and nothing is said.
    const moved = classify(look(stalled, busy(), presence(26 * MIN)), 26 * MIN);
    expect(moved).toEqual([{ kind: "stall", row: stalled, stall: null }]);
    // A new silence after that is a new stretch, with its own key.
    expect(queuedWakes(classify(look(row(), busy(), presence(26 * MIN)), 33 * MIN)).map((w) => w.key)).toEqual([`stall:t1:1:${26 * MIN}`]);
  });

  it("a restart is a non-event: a stall stored before it keeps its stretch, so no second notice and no fresh 20 minutes", () => {
    const stalled = row({ stallKind: "quiet", stallReason: "", stalledAt: 10 * MIN });
    // The app came back at 30 min: this window first sees the worker then, and has seen nothing from it since.
    const fresh: Presence = { watchedSince: 30 * MIN, lastProgressAt: 30 * MIN, steps: -1 };
    expect(kinds(classify(look(stalled, busy(), fresh), 30 * MIN + 1))).toEqual(["stop"]);
    const stillShort = row({ stallKind: "quiet", stallReason: "", stalledAt: 20 * MIN });
    const told = queuedWakes(classify(look(stillShort, busy(), { ...fresh, watchedSince: 36 * MIN }), 36 * MIN + 1));
    expect(told.map((w) => w.key)).toEqual([`stall:t1:1:${20 * MIN}`]);
  });

  it("an idle worker that stopped without reporting is told the same way", () => {
    const [w] = queuedWakes(classify(look(row(), busy({ busy: false }), presence(0)), 7 * MIN));
    expect(w.text).toContain("stopped 7 minutes ago without reporting back");
  });

  it("a provider-error stall keeps its own road (self-repair's note, with a retry)", () => {
    const decided = classify(look(row(), busy({ providerError: "API Error: Server error" }), { ...presence(0), errorSince: 0 }), 2 * MIN);
    expect(queuedWakes(decided)).toEqual([]);
    const [w] = wakes(decided);
    expect(w.route).toBe("provider-note");
    expect(w.stall?.reason.startsWith(PROVIDER_STALL_PREFIX)).toBe(true);
  });

  it("twenty silent minutes with nothing pending: stopped and failed, retryable, and no stall notice on top", () => {
    const decided = classify(look(row(), busy(), presence(0)), SILENCE_MS);
    expect(decided).toEqual([
      expect.objectContaining({ kind: "stop", errorClass: "silent", since: 0, error: expect.stringContaining("Silent for 20 minutes") }),
    ]);
    // The error never says what self-repair retries on by itself.
    const stop = decided[0] as Extract<Decision, { kind: "stop" }>;
    expect(stop.error).not.toMatch(/\b(exited|crash(ed)?|killed|signal|terminated|timed out)\b/i);
    expect(kinds(classify(look(row(), busy({ busy: false }), presence(0)), 25 * MIN))).toEqual(["stop"]);
  });

  it("an approval or a question never counts as silence, however long", () => {
    const asking = busy({ asking: true });
    expect(kinds(classify(look(row(), asking, presence(0)), 3 * 60 * MIN))).not.toContain("stop");
    expect(kinds(classify(look(row(), asking, presence(0)), 3 * 60 * MIN))).not.toContain("wake");
  });

  it("nor does a queued message, a usage limit, waiting on its own workers, or a first mate's own long chat", () => {
    for (const held of [busy({ queued: true, busy: false }), busy({ limited: true, busy: false })])
      expect(kinds(classify(look(row(), held, presence(0)), 60 * MIN))).not.toContain("stop");
    expect(kinds(classify(look(row(), busy(), presence(0), { waitsOnWorkers: true }), 60 * MIN))).not.toContain("stop");
    expect(kinds(classify(look(row({ follow: "lead" }), busy(), presence(0)), 60 * MIN))).not.toContain("stop");
  });

  it("a declared block is never judged, and the clock starts when the watcher first sees a worker", () => {
    expect(kinds(classify(look(row({ stallKind: "blocked" }), busy(), presence(0)), 60 * MIN))).toEqual(["record"]);
    const fresh: Presence = { watchedSince: 100 * MIN, lastProgressAt: 100 * MIN, steps: -1 };
    expect(kinds(classify(look(row(), busy(), fresh), 105 * MIN))).toEqual(["record"]);
  });
});

describe("PR events and timers", () => {
  it("CI red and a merge on the crew's pull request keep pr_watch's road", () => {
    for (const event of ["ci-red", "merged"] as const)
      expect(wakes(classify({ kind: "pr", ownerSession: "lead", event, title: "#12" }, 0))[0]).toMatchObject({ kind: "pr", route: "pr-watch" });
  });

  it("a timer the first mate set wakes it through the queue", () => {
    const [w] = queuedWakes(classify({ kind: "timer", ownerSession: "lead", timerId: "timer-1", note: "look at the deploy" }, 0));
    expect(w).toMatchObject({ kind: "timer", key: "timer:timer-1", text: "Your timer: look at the deploy" });
  });
});
