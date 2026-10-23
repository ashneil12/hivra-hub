// What harness care can see (board H1/H3): the database checks, a stuck ship trial, a watch whose reads keep failing, a
// chat that stopped resuming, delegated work whose chat is gone — each read from what the app already holds.
import { describe, expect, it } from "vitest";
import { NO_SHIP } from "../../../app/model/ship";
import { careFaults, ORPHAN_GRACE_MS, SHIP_TRIAL_GRACE_MS, WATCH_FAILURES, type CareLook } from "./careFaults";
import { mayFix } from "./harnessCare";
import type { Delegation, DelegationTracker } from "./delegations";
import type { PrWatch } from "../../pr-watch/model/prWatches";
import type { Session } from "../../sessions/model/session";

const T = Date.UTC(2026, 9, 22, 9);
const MIN = 60_000;

const stoppedBlock = { id: "b-2", role: "system", text: "The app stopped resuming this turn.", notice: "resume-stopped" };

const chat = (over: Partial<Session> = {}): Session => ({ id: "c-1", blocks: [], ...over }) as unknown as Session;

const watch = (over: Partial<PrWatch> = {}): PrWatch =>
  ({ id: "w-1", ownerSession: "s-1", repo: "acme/app", number: 12, state: "watching", readFailures: 0, lastError: null, lastReadAt: null, ...over }) as unknown as PrWatch;

const row = (over: Partial<Delegation> = {}): Delegation =>
  ({
    id: "d-1",
    ownerSession: "lead",
    childSession: "c-1",
    state: "running",
    follow: null,
    title: "Fix the save bug",
    updatedAt: T - ORPHAN_GRACE_MS - MIN,
    ...over,
  }) as unknown as Delegation;

const tracker = (rows: Delegation[], loaded = true): DelegationTracker =>
  ({ isLoaded: () => loaded, known: () => rows }) as unknown as DelegationTracker;

const look = (over: Partial<CareLook> = {}): CareLook => ({
  now: T,
  sessions: [],
  tracker: null,
  database: null,
  watches: null,
  ship: NO_SHIP,
  trialSeenAt: null,
  ...over,
});

const trial = (over: Record<string, unknown> = {}) =>
  ({ ...NO_SHIP, enabled: true, holding: true, trial: { id: "ship-1", committed: false }, ...over }) as CareLook["ship"];

describe("the database", () => {
  it("says nothing when the check passed, or hasn't run", () => {
    expect(careFaults(look())).toEqual([]);
    expect(careFaults(look({ database: { ok: true, code: 0 } }))).toEqual([]);
  });

  it("names a database from a newer build as the one thing to know", () => {
    const [fault, ...rest] = careFaults(look({ database: { ok: false, code: 65, report: { refused: "newer-schema" } } }));
    expect(rest).toEqual([]);
    expect(fault).toMatchObject({ kind: "database", id: "database" });
    expect(fault.fix).toBeUndefined();
    expect(fault.line).toContain("newer build");
    expect(fault.line).toContain("Nothing was changed");
  });

  it("reports a failed integrity check with what it found", () => {
    const [fault] = careFaults(look({ database: { ok: false, code: 1, report: { integrity: "*** in database main ***\nPage 4 is never used" } } }));
    expect(fault.line).toContain("integrity check");
    expect(fault.line).toContain("Page 4 is never used");
    expect(fault.line).not.toContain("\n");
  });

  it("reports a plain failure with its exit code and error, and that the live file was only read", () => {
    const [fault] = careFaults(look({ database: { ok: false, code: 1, report: { error: "no such table: sessions" } } }));
    expect(fault.line).toContain("exit 1");
    expect(fault.line).toContain("no such table: sessions");
    expect(fault.line).toContain("live file wasn't touched");
  });
});

describe("the ship", () => {
  it("leaves a build that is on trial alone inside its grace", () => {
    expect(careFaults(look({ ship: trial(), trialSeenAt: T - SHIP_TRIAL_GRACE_MS + MIN }))).toEqual([]);
  });

  it("leaves a ship alone when it isn't holding a trial", () => {
    expect(careFaults(look({ ship: trial({ holding: false }), trialSeenAt: T - 2 * SHIP_TRIAL_GRACE_MS }))).toEqual([]);
    expect(careFaults(look({ ship: trial({ trial: { id: "ship-1", committed: true } }), trialSeenAt: T - 2 * SHIP_TRIAL_GRACE_MS }))).toEqual([]);
  });

  it("calls a trial that never committed stuck, and says where its folder is", () => {
    const [fault] = careFaults(
      look({
        ship: trial({ current: { id: "ship-1", shipDir: "/data/ship/ship-1" } as never }),
        trialSeenAt: T - SHIP_TRIAL_GRACE_MS,
      }),
    );
    expect(fault).toMatchObject({ kind: "ship", id: "ship-ship-1", path: "/data/ship/ship-1", since: T - SHIP_TRIAL_GRACE_MS });
    expect(fault.fix).toBeUndefined();
    expect(fault.line).toContain("puts the old build back");
  });
});

describe("a pull request watch", () => {
  it("ignores a single failed read, since the watch retries by itself first", () => {
    expect(WATCH_FAILURES).toBeGreaterThan(1);
    expect(careFaults(look({ watches: [watch({ readFailures: 1, lastError: "HTTP 403" })] }))).toEqual([]);
  });

  it("pauses one whose reads keep failing, on the watch it names", () => {
    const [fault] = careFaults(
      look({ watches: [watch({ readFailures: WATCH_FAILURES, lastError: "HTTP 403: forbidden\n(no access)", lastReadAt: T - MIN })] }),
    );
    expect(fault).toMatchObject({ kind: "pr-watch", id: "pr-watch-w-1", fix: "pause-pr-watch", since: T - MIN });
    expect(fault.about).toEqual({ watch: { ownerSession: "s-1", id: "w-1" } });
    expect(fault.line).toContain("acme/app#12");
    expect(fault.line).toContain("HTTP 403");
    expect(fault.line).not.toContain("\n");
  });

  it("ignores an ended watch and a failed read with no error line", () => {
    expect(careFaults(look({ watches: [watch({ state: "ended", readFailures: 4, lastError: "HTTP 500" })] }))).toEqual([]);
    expect(careFaults(look({ watches: [watch({ readFailures: 4, lastError: null })] }))).toEqual([]);
  });
});

describe("a chat that stopped resuming", () => {
  it("continues one the app had left waiting, and never a busy chat", () => {
    const [fault] = careFaults(look({ sessions: [chat({ blocks: [stoppedBlock] as Session["blocks"] })] }));
    expect(fault).toMatchObject({ kind: "resume", id: "resume-c-1", fix: "continue-chat", about: { session: "c-1" } });
    expect(mayFix(fault)).toBe(true);
    expect(careFaults(look({ sessions: [chat({ busy: true, blocks: [stoppedBlock] as Session["blocks"] })] }))).toEqual([]);
    expect(careFaults(look({ sessions: [chat()] }))).toEqual([]);
  });

  it("leaves the continue to Ash while a usage window is open", () => {
    const [fault] = careFaults(
      look({ sessions: [chat({ blocks: [stoppedBlock] as Session["blocks"], usageLimit: { resetsAt: T + 60 * MIN } })] }),
    );
    expect(fault.failure).toEqual({ reason: "usage limit", retryable: true, resetsAt: T + 60 * MIN });
    expect(mayFix(fault)).toBe(false);
  });
});

describe("delegated work whose chat is gone", () => {
  it("cancels a running row once its chat has been gone past the grace", () => {
    const [fault] = careFaults(look({ sessions: [chat({ id: "c-9" })], tracker: tracker([row()]) }));
    expect(fault).toMatchObject({ kind: "orphan", id: "orphan-d-1", fix: "cancel-orphan", about: { delegation: "d-1" } });
    expect(fault.line).toBe("Fix the save bug: delegated work is still marked running, but the chat it ran in is gone.");
  });

  it("leaves a row alone inside the grace, while its chat is open, or when it is a followed brief", () => {
    expect(careFaults(look({ sessions: [chat({ id: "c-9" })], tracker: tracker([row({ updatedAt: T - MIN })]) }))).toEqual([]);
    expect(careFaults(look({ sessions: [chat()], tracker: tracker([row()]) }))).toEqual([]);
    expect(careFaults(look({ sessions: [chat({ id: "c-9" })], tracker: tracker([row({ follow: "report" as never })]) }))).toEqual([]);
  });

  it("does nothing until the chats and the rows have loaded", () => {
    expect(careFaults(look({ sessions: [chat({ id: "c-9" })], tracker: tracker([row()], false) }))).toEqual([]);
    expect(careFaults(look({ sessions: [], tracker: tracker([row()]) }))).toEqual([]);
  });

  it("falls back to its own word when the row has no title", () => {
    const [fault] = careFaults(look({ sessions: [chat({ id: "c-9" })], tracker: tracker([row({ title: null })]) }));
    expect(fault.line).toContain("Delegated work is still marked running");
  });
});

describe("one look", () => {
  it("reads every fault the app can see, in a plain order", () => {
    const faults = careFaults(
      look({
        sessions: [chat({ id: "c-9", blocks: [stoppedBlock] as Session["blocks"] })],
        tracker: tracker([row()]),
        database: { ok: false, code: 65, report: { refused: "newer-schema" } },
        watches: [watch({ readFailures: WATCH_FAILURES, lastError: "HTTP 403", lastReadAt: T - MIN })],
        ship: trial(),
        trialSeenAt: T - SHIP_TRIAL_GRACE_MS,
      }),
    );
    expect(faults.map((fault) => fault.id)).toEqual(["database", "ship-ship-1", "pr-watch-w-1", "resume-c-9", "orphan-d-1"]);
  });
});
