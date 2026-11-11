// @vitest-environment happy-dom
// WP-176 re-review of #217 (round 3), red first. Each test asserts the outcome the brief and the round-2 report
// promise; on head 5607ed698 they fail.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSession } from "./history";
import {
  admitSpendTurn,
  resetSpendGate,
  reviewReportedTurn,
  saveSpendLimit,
  saveTaskCeiling,
  setSpendClock,
  setSpendProjectLookup,
  setSpendRecords,
  setSpendSessions,
  setSpendWarnSink,
} from "./spendGate";

const now = Date.parse("2026-11-10T15:00:00");
const HUB = { id: "hivra", folder: "/Users/ash/Projects/monocode-hub" };

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
      resolveFolder: async () => "/Volumes/Data/Projects/monocode-hub",
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
