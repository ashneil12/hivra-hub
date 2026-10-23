// Harness care (board H1/H3): what the app can see about itself, it fixes with backoff and leaves a Bot changes row;
// what it can't, it tells once and stops.
import { describe, expect, it, vi } from "vitest";
import { CARE_BACKOFF_MS, CARE_RESET_MS, HarnessCare, mayFix, resumeStoppedNote, SAFE_FIXES, type CareFault } from "./harnessCare";

const T = Date.UTC(2026, 9, 22, 9);
const MIN = 60_000;

const fault = (over: Partial<CareFault> = {}): CareFault => ({
  kind: "pr-watch",
  id: "pr-watch-w-1",
  line: "Reading acme/app#12 has failed 2 times (HTTP 403), and the watch keeps asking.",
  fix: "pause-pr-watch",
  about: { watch: { ownerSession: "s-1", id: "w-1" } },
  ...over,
});

function bench() {
  let now = T;
  const tried: CareFault[] = [];
  const fixed: CareFault[] = [];
  const told: CareFault[] = [];
  const cleared: string[] = [];
  const outcome = { ok: true, throwFor: null as string | null };
  const care = new HarnessCare({
    now: () => now,
    fix: (fault) => {
      tried.push(fault);
      if (outcome.throwFor === fault.id) throw new Error("the fix itself failed");
      return outcome.ok;
    },
    fixed: (fault) => {
      fixed.push(fault);
    },
    tell: (fault) => {
      told.push(fault);
    },
    clear: (fault) => {
      cleared.push(fault.id);
    },
  });
  return { care, tried, fixed, told, cleared, outcome, at: (t: number) => (now = t) };
}

describe("a fault it can fix safely", () => {
  it("waits its first minute, then fixes it once and leaves the Bot changes row", async () => {
    const { care, tried, fixed, told, at } = bench();
    await care.tick([fault()]);
    expect(tried).toEqual([]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 0, told: false, done: false });
    at(T + CARE_BACKOFF_MS[0]);
    await care.tick([fault()]);
    expect(tried).toHaveLength(1);
    expect(fixed).toEqual([fault()]);
    expect(told).toEqual([]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ done: true });
    // The fault still stands on later looks: a fix that went through is not made twice.
    at(T + 3 * 60 * MIN);
    await care.tick([fault()]);
    expect(tried).toHaveLength(1);
    expect(fixed).toHaveLength(1);
    expect(SAFE_FIXES["pause-pr-watch"]).toContain("Paused a pull request watch");
  });

  it("makes three tries with backoff, then tells once and stops", async () => {
    const { care, tried, told, outcome, at } = bench();
    outcome.ok = false;
    await care.tick([fault()]);
    let now = T;
    for (const wait of CARE_BACKOFF_MS) {
      now += wait;
      at(now);
      await care.tick([fault()]);
    }
    expect(tried).toHaveLength(CARE_BACKOFF_MS.length);
    expect(told).toEqual([]);
    // One more wait, and its safe tries have run out: Ash's now, said once.
    now += CARE_BACKOFF_MS[CARE_BACKOFF_MS.length - 1];
    at(now);
    await care.tick([fault()]);
    expect(tried).toHaveLength(CARE_BACKOFF_MS.length);
    expect(told).toHaveLength(1);
    at(now + 2 * 60 * MIN);
    await care.tick([fault()]);
    expect(told).toHaveLength(1);
  });

  it("counts a fix that throws as a try and never stops the other faults on the look", async () => {
    const { care, tried, fixed, outcome, at } = bench();
    outcome.throwFor = "pr-watch-w-1";
    const faults = [fault(), fault({ kind: "orphan", id: "orphan-d-1", fix: "cancel-orphan", about: { delegation: "d-1" } })];
    await care.tick(faults);
    at(T + CARE_BACKOFF_MS[0]);
    await care.tick(faults);
    expect(tried.map((entry) => entry.id)).toEqual(["pr-watch-w-1", "orphan-d-1"]);
    expect(fixed.map((entry) => entry.id)).toEqual(["orphan-d-1"]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 1, done: false });
  });

  it("never lets one fault's own handling stop the rest of the look", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixed: string[] = [];
    const care = new HarnessCare({
      now: () => T + MIN,
      fix: () => true,
      fixed: (entry) => {
        fixed.push(entry.id);
        if (entry.id === "a") throw new Error("the changes row wouldn't save");
      },
      tell: () => undefined,
    });
    await care.tick([fault({ id: "a", since: T }), fault({ id: "b", since: T })]);
    expect(fixed).toEqual(["a", "b"]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("finishes one look before it starts the next", async () => {
    let release = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tried: string[] = [];
    const care = new HarnessCare({
      now: () => T + MIN,
      fix: async (entry) => {
        tried.push(entry.id);
        await gate;
        return true;
      },
      fixed: () => undefined,
      tell: () => undefined,
    });
    const first = care.tick([fault({ since: T })]);
    const second = care.tick([fault({ since: T })]);
    release();
    await Promise.all([first, second]);
    expect(tried).toEqual(["pr-watch-w-1"]);
  });
});

describe("a fault it cannot fix", () => {
  it("is told once, though it stands", async () => {
    const { care, tried, told, at } = bench();
    await care.tick([fault({ fix: undefined, about: undefined })]);
    expect(tried).toEqual([]);
    expect(told).toHaveLength(1);
    at(T + 2 * 60 * MIN);
    await care.tick([fault({ fix: undefined, about: undefined })]);
    expect(told).toHaveLength(1);
  });

  it("stops a stopped chat's continue at a usage window, and never tries it", async () => {
    const { care, tried, told, at } = bench();
    const usage = fault({
      kind: "resume",
      id: "resume-c-1",
      fix: "continue-chat",
      about: { session: "c-1" },
      failure: { reason: "usage limit", retryable: true, resetsAt: T + 3 * 60 * MIN },
    });
    await care.tick([usage]);
    at(T + CARE_BACKOFF_MS[0]);
    await care.tick([usage]);
    expect(tried).toEqual([]);
    expect(told).toHaveLength(1);
  });

  it("continues a stopped chat with no refusal against it", async () => {
    const { care, tried, fixed, at } = bench();
    const stopped = fault({ kind: "resume", id: "resume-c-1", fix: "continue-chat", about: { session: "c-1" } });
    await care.tick([stopped]);
    at(T + CARE_BACKOFF_MS[0]);
    await care.tick([stopped]);
    expect(tried).toHaveLength(1);
    expect(fixed).toHaveLength(1);
  });
});

describe("forgetting", () => {
  it("hands back a told row the moment its fault goes", async () => {
    const { care, cleared } = bench();
    await care.tick([{ kind: "database", id: "database", line: "The app's database didn't pass its health check." }]);
    await care.tick([]);
    expect(cleared).toEqual(["database"]);
  });

  it("keeps an untold fault's tries for half an hour, then starts it over", async () => {
    const { care, tried, outcome, at } = bench();
    outcome.ok = false;
    await care.tick([fault()]);
    at(T + CARE_BACKOFF_MS[0]);
    await care.tick([fault()]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 1 });
    at(T + 2 * MIN);
    await care.tick([]);
    at(T + 2 * MIN + CARE_RESET_MS - MIN);
    await care.tick([]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 1 });
    at(T + 2 * MIN + CARE_RESET_MS + MIN);
    await care.tick([]);
    expect(care.state("pr-watch-w-1")).toBeUndefined();
    // Back with fresh tries: it waits its first minute again, then tries like a fault seen for the first time.
    await care.tick([fault()]);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 0, done: false });
    at(T + 2 * MIN + CARE_RESET_MS + 2 * MIN);
    await care.tick([fault()]);
    expect(tried).toHaveLength(2);
    expect(care.state("pr-watch-w-1")).toMatchObject({ tries: 1 });
  });
});

describe("what care may fix by itself", () => {
  it("is a fix care names, and a continue that passes the same list as every retry", () => {
    expect(mayFix({})).toBe(false);
    expect(mayFix({ fix: "pause-pr-watch" })).toBe(true);
    expect(mayFix({ fix: "cancel-orphan" })).toBe(true);
    expect(mayFix({ fix: "continue-chat" })).toBe(true);
    expect(mayFix({ fix: "continue-chat", failure: { reason: "usage limit", retryable: true } })).toBe(false);
    expect(mayFix({ fix: "continue-chat", failure: { reason: "Out of credits", retryable: false } })).toBe(false);
    expect(mayFix({ fix: "continue-chat", failure: { reason: "The model's API failed", retryable: true } })).toBe(true);
  });
});

describe("the note a chat gets", () => {
  it("says the app couldn't pick the turn up, in the app's own voice, once a minute", () => {
    const note = resumeStoppedNote("c-1", T);
    expect(note.text).toContain("[MonoCode self-repair]");
    expect(note.text).toContain("this is the app, not Ash");
    expect(String(note.monoNote?.line ?? "").length).toBeLessThanOrEqual(160);
    expect(note.id).toBe(resumeStoppedNote("c-1", T + 1_000).id);
    expect(note.id).not.toBe(resumeStoppedNote("c-1", T + MIN).id);
  });
});
