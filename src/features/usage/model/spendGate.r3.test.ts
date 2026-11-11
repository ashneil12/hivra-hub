// @vitest-environment happy-dom
// WP-176 round 3 (#217). The first five tests are the review's repros, now asserting the outcome the brief promises;
// they failed on 5607ed698. The rest pin the other round 3 fixes, each red before its change.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSession } from "./history";
import {
  admitSpendTurn,
  clearSpendLimit,
  judgeLaunch,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendBookStore,
  setSpendClock,
  setSpendLoader,
  setSpendMonotonicClock,
  setSpendProjectLookup,
  setSpendRecords,
  setSpendSessions,
  setSpendWarnSink,
  type SpendBookStore,
} from "./spendGate";

const now = Date.parse("2026-11-10T15:00:00");
const HUB = { id: "hivra", folder: "/work/monocode-hub" };

function row(id: string, cwd: string, costUsd: number): UsageSession {
  return { id, cwd, harness: "claude", model: "opus", blocks: [{ id: `${id}-t`, role: "user", startedAt: now, turnMetrics: { costUsd, inputTokens: 5 } }] };
}

beforeEach(() => {
  localStorage.clear();
  resetSpendGate();
  setSpendClock(() => now);
  setSpendWarnSink({ wake: async () => ({ fresh: true }), activity: () => undefined });
});

describe("R3-H1: the app tags every turn as the person's", () => {
  const app = readFileSync(resolve(__dirname, "../../../app/App.tsx"), "utf8");
  const start = app.indexOf("const submitSession = useCallback(");
  const end = app.indexOf("submitAfterProjectSyncRef.current = submitSession;");
  const body = app.slice(start, end);

  it("submitSession is the path habits, automations, agent sends, steering and continue prompts take", () => {
    expect(start).toBeGreaterThan(0);
    expect(app).toMatch(/run: \(id, prompt\) =>[\s\S]{0,200}submitSession\(id, prompt, \[\], \{ onSettled \}\)/); // habit runs
    expect(app).toMatch(/submit: \(sessionId, text, options\) => submitSession\(sessionId, text, \[\], options\)/); // agent app
    expect(app).toMatch(/submitSession\(sessionId, CONTINUE_PROMPT\)/); // continue after a usage limit
  });

  it("the turn's origin comes from the caller, not a literal that marks every turn as a person's", () => {
    // Head 5607ed698: `origin: "person",` is hard-coded in the one sendHarnessTurn call every turn uses, so a habit,
    // an automation, a wake and an agent's sessions.send all pass admission as the person's composer.
    expect(body).toContain("sendHarnessTurn({");
    expect(body).not.toMatch(/sendHarnessTurn\(\{\s*\/\/[^\n]*\n\s*origin: "person",/);
  });
});

describe("R3-H1 consequence: what a person-tagged automated turn gets through", () => {
  beforeEach(() => {
    setSpendProjectLookup({ idOf: (f) => (f === HUB.folder ? HUB.id : undefined), folderOf: (id) => (id === HUB.id ? HUB.folder : undefined) });
  });

  it("control: the daily ceiling holds a billed run only when its origin is automated", () => {
    // claude.ts sets live.target.origin from input.origin, which submitSession always sets to "person", so in the app
    // a habit or worker run is never unattended and its daily ceiling never holds it (step 9 of the brief).
    setSpendRecords([]);
    saveTaskCeiling(HUB.id, { dailyUsd: 1 }, 0);
    const asApp = reviewReportedTurn({ sessionId: "habit-run", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: { costUsd: 5 } });
    const asMeant = reviewReportedTurn({ sessionId: "habit-run-2", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "automated", metrics: { costUsd: 5 } });
    expect(asApp.stopRun).toBe(false);
    expect(asMeant.stopRun).toBe(true);
  });
});

describe("R3-M: the git answer and the hub id can disagree", () => {
  beforeEach(() => {
    setSpendSessions([row("chat", HUB.folder, 500)]);
  });

  it("a project registered through a symlinked folder still meets its limit (git answers the real path)", async () => {
    setSpendProjectLookup({
      idOf: (f) => (f === HUB.folder ? HUB.id : undefined),
      folderOf: (id) => (id === HUB.id ? HUB.folder : undefined),
      // `git rev-parse --path-format=absolute --git-common-dir` resolves symlinks (checked on Linux git 2.x).
      resolveFolder: async () => "/real/work/monocode-hub",
    });
    saveSpendLimit({ scope: "project", project: HUB.id, period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    expect(await admitSpendTurn({ sessionId: "w1", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });

  it("before the hub's projects have loaded, an automated turn over its project limit is not admitted", async () => {
    let loaded = false;
    setSpendProjectLookup({
      idOf: (f) => (loaded && f === HUB.folder ? HUB.id : undefined),
      folderOf: (id) => (loaded && id === HUB.id ? HUB.folder : undefined),
    });
    loaded = true;
    saveSpendLimit({ scope: "project", project: HUB.id, period: "month", amountUsd: 10, warnAt: 0.8 }, 0, { by: "person" });
    loaded = false; // a cold start: the limit is stored, the hub store has not answered yet
    expect(await admitSpendTurn({ sessionId: "resume-1", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
  });
});

const flush = () => new Promise((done) => setTimeout(done, 0));
const SPEND_APP = { scope: "app" as const, period: "month" as const, amountUsd: 10, warnAt: 0.8 };

describe("R3-L: the record TTL runs on a clock that only moves forward", () => {
  it("a wall clock set back does not stop the ledger being read again", async () => {
    let mono = 0;
    let loads = 0;
    setSpendMonotonicClock(() => mono);
    setSpendLoader(async () => {
      loads += 1;
      return [];
    });
    saveSpendLimit(SPEND_APP, 0, { by: "person" });
    judgeLaunch({ project: HUB.id, harness: "claude" });
    await flush();
    expect(loads).toBe(1);
    setSpendClock(() => now - 3_600_000);
    mono += 6_000;
    judgeLaunch({ project: HUB.id, harness: "claude" });
    await flush();
    expect(loads).toBe(2);
    setSpendMonotonicClock(null);
  });
});

describe("R3-M3: the limits book is the app database's, and a store that fails holds automated turns", () => {
  const withStore = (store: SpendBookStore) => setSpendBookStore(store);

  it("a database that cannot answer holds automated turns, even with nothing in localStorage", async () => {
    await withStore({
      read: async () => {
        throw new Error("database unavailable");
      },
      write: async () => undefined,
    });
    expect(await admitSpendTurn({ sessionId: "s", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
    expect(await admitSpendTurn({ sessionId: "s", cwd: HUB.folder, harness: "claude", origin: "person" })).toMatchObject({ ok: true });
    await withStore(null as unknown as SpendBookStore);
  });

  it("a limit held only in the database refuses an automated turn over it", async () => {
    localStorage.clear();
    setSpendRecords([{ projectKey: HUB.folder, sessionId: "chat", day: "2026-11-10", micros: 50_000_000, priced: 1, unpriced: 0 }]);
    await withStore({
      read: async () => ({ revision: 1, limits: [SPEND_APP], ceilings: {} }),
      write: async () => undefined,
    });
    expect(await admitSpendTurn({ sessionId: "w", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
    await withStore(null as unknown as SpendBookStore);
  });

  it("a save the database refuses is not dropped: automated turns stay held until it lands", async () => {
    let attempts = 0;
    await withStore({
      read: async () => null,
      write: async () => {
        attempts += 1;
        throw new Error("conflict");
      },
    });
    saveSpendLimit(SPEND_APP, 0, { by: "person" });
    await flush();
    expect(attempts).toBeGreaterThan(0);
    expect(await admitSpendTurn({ sessionId: "w2", cwd: HUB.folder, harness: "claude", origin: "automated" })).toMatchObject({ ok: false });
    await withStore(null as unknown as SpendBookStore);
  });
});

describe("R3-M2b: a soft ask asks once, and a person's continue is recorded", () => {
  it("the soft ask is a notice once; the person's turn continues it; the hard stop still holds", async () => {
    setSpendRecords([]);
    saveTaskCeiling(HUB.id, { hardUsd: 10, softAt: 0.8 }, 0);
    setSpendProjectLookup({ idOf: (f) => (f === HUB.folder ? HUB.id : undefined), folderOf: (id) => (id === HUB.id ? HUB.folder : undefined) });
    const metrics = (costUsd: number) => ({ costUsd, inputTokens: 5 });
    const first = reviewReportedTurn({ sessionId: "run", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: metrics(8.5) });
    expect(first).toMatchObject({ ask: true, notice: true, stopRun: false });
    await admitSpendTurn({ sessionId: "run", cwd: HUB.folder, harness: "claude", model: "custom:acme", origin: "person" });
    const next = reviewReportedTurn({ sessionId: "run", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: metrics(0.1) });
    expect(next).toMatchObject({ ask: false, notice: false, stopRun: false });
    const hard = reviewReportedTurn({ sessionId: "run", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: metrics(2) });
    expect(hard).toMatchObject({ stopRun: true });
  });
});

describe("R3-M1b: a redo keeps counting against its parent's ceiling", () => {
  it("a redo chat over its parent's task ceiling is held", async () => {
    setSpendSessions([{ id: "parent", cwd: HUB.folder, harness: "claude", model: "opus", blocks: [{ id: "p-t", role: "user", startedAt: now, turnMetrics: { costUsd: 9.5, inputTokens: 5 } }] }]);
    setSpendProjectLookup({
      idOf: (f) => (f === HUB.folder ? HUB.id : undefined),
      folderOf: (id) => (id === HUB.id ? HUB.folder : undefined),
      redoParentOf: (id) => (id === "redo" ? "parent" : undefined),
    });
    saveTaskCeiling(HUB.id, { hardUsd: 9 }, 0);
    expect(await admitSpendTurn({ sessionId: "redo", cwd: HUB.folder, harness: "claude", model: "custom:acme", origin: "automated" })).toMatchObject({ ok: false });
  });
});

describe("R3-L: an all-unpriced task ceiling is reported, once", () => {
  it("the first unmeasured turn carries a notice; the next does not repeat it", () => {
    setSpendRecords([]);
    setSpendProjectLookup({ idOf: (f) => (f === HUB.folder ? HUB.id : undefined), folderOf: (id) => (id === HUB.id ? HUB.folder : undefined) });
    saveTaskCeiling(HUB.id, { hardUsd: 10 }, 0);
    const a = reviewReportedTurn({ sessionId: "unpriced", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: { inputTokens: 5 } });
    expect(a).toMatchObject({ status: "unmeasured", notice: true });
    const b = reviewReportedTurn({ sessionId: "unpriced", cwd: HUB.folder, model: "custom:acme", harness: "claude", origin: "person", metrics: { inputTokens: 5 } });
    expect(b).toMatchObject({ status: "unmeasured", notice: false });
  });
});

describe("R3-L: clearing a limit that does not exist says so", () => {
  it("clearing with no limit set reports that there is none", () => {
    setSpendRecords([]);
    const result = clearSpendLimit("app", "", "month", 0, { by: "person" });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("There is no spend limit to clear.");
  });
});
