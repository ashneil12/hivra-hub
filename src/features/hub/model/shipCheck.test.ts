// SC-3b: the ship check's webview half (hub/model/shipCheck.ts, src-tauri/src/ship_check.rs). What these keep honest: a
// record read from the app is untrusted and never reads as a pass the steps don't support, a result that could not run
// says so in its own words, and two clicks (or a click and a first mate's tool call) never start two runs.
import { describe, expect, it, vi } from "vitest";
import {
  commitsLine,
  latestShipCheck,
  outcomeWord,
  readShipCheckRecord,
  runShipCheck,
  shipCheckError,
  shipCheckRunning,
  shortSha,
  stepWord,
  subscribeShipChecks,
  type ShipCheckBackend,
  type ShipCheckRecord,
} from "./shipCheck";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function record(over: Partial<ShipCheckRecord> = {}): ShipCheckRecord {
  return {
    project: "/work/app",
    head: HEAD,
    base: "fedcba9876543210fedcba9876543210fedcba98",
    commitsCovered: 4,
    at: 1_700_000_000_000,
    outcome: "passed",
    note: null,
    steps: [
      { name: "Project checks", outcome: "passed", detail: "ran and passed" },
      { name: "Test guard", outcome: "passed", detail: "no test was weakened" },
      { name: "Review", outcome: "notRun", detail: "not run: no task briefs landed in this range" },
    ],
    tested: ["Web checks passed."],
    notTested: ["No review: no task briefs landed in this range."],
    ...over,
  };
}

function backend(over: Partial<ShipCheckBackend> = {}): ShipCheckBackend {
  return {
    run: vi.fn(async () => record()),
    latest: vi.fn(async () => null),
    passed: vi.fn(async () => false),
    head: vi.fn(async () => HEAD),
    ...over,
  };
}

describe("the words", () => {
  it("names the three outcomes in plain words, and never calls a run that could not finish a pass", () => {
    expect(outcomeWord("passed")).toBe("Passed");
    expect(outcomeWord("failed")).toBe("Failed");
    expect(outcomeWord("couldNotRun")).toBe("Couldn't run everything");
    expect(stepWord("couldNotRun")).toBe("Couldn't run");
    expect(stepWord("notRun")).toBe("Not run");
  });

  it("shortens a version to seven characters and says nothing for a value that is not one", () => {
    expect(shortSha(HEAD)).toBe("0123456");
    expect(shortSha("  abc1234def  ")).toBe("abc1234");
    expect(shortSha("")).toBe("");
    expect(shortSha(null)).toBe("");
    expect(shortSha(undefined)).toBe("");
  });

  it("counts commits with the right noun", () => {
    expect(commitsLine(1)).toBe("1 commit");
    expect(commitsLine(30)).toBe("30 commits");
    expect(commitsLine(0)).toBe("no commits");
  });

  it("gives the app's own words for a failure, else one usual line", () => {
    expect(shipCheckError("Another ship check is already running for this project.")).toBe(
      "Another ship check is already running for this project.",
    );
    expect(shipCheckError(new Error("git is not available"))).toBe("git is not available");
    expect(shipCheckError(undefined)).toBe("The ship check could not run.");
    expect(shipCheckError("   ")).toBe("The ship check could not run.");
  });
});

describe("a record read from the app", () => {
  it("is taken whole when it is well formed", () => {
    expect(readShipCheckRecord(record())).toEqual(record());
  });

  it("is refused when it is not an object, has no version or has an outcome this build doesn't know", () => {
    expect(readShipCheckRecord(null)).toBeNull();
    expect(readShipCheckRecord("passed")).toBeNull();
    expect(readShipCheckRecord([])).toBeNull();
    expect(readShipCheckRecord({ ...record(), head: "" })).toBeNull();
    expect(readShipCheckRecord({ ...record(), head: 7 })).toBeNull();
    expect(readShipCheckRecord({ ...record(), outcome: "fine" })).toBeNull();
    expect(readShipCheckRecord({ ...record(), outcome: undefined })).toBeNull();
  });

  it("reads a step outcome it doesn't know as one that could not run, never as a pass", () => {
    const got = readShipCheckRecord({
      ...record(),
      steps: [{ name: "Project checks", outcome: "great", detail: "ok" }],
    });
    expect(got?.steps[0].outcome).toBe("couldNotRun");
    // The whole record cannot stay a pass beside a step that is not one.
    expect(got?.outcome).toBe("couldNotRun");
  });

  it("will not show a pass over a step that failed or could not run", () => {
    const failed = readShipCheckRecord(
      record({ steps: [{ name: "Project checks", outcome: "failed", detail: "failed (exit 1)" }] }),
    );
    expect(failed?.outcome).toBe("failed");
    const unable = readShipCheckRecord(
      record({ steps: [{ name: "Review", outcome: "couldNotRun", detail: "no answer" }] }),
    );
    expect(unable?.outcome).toBe("couldNotRun");
    // A failed record stays failed, and a could-not-run record is not made worse.
    expect(readShipCheckRecord(record({ outcome: "failed" }))?.outcome).toBe("failed");
    expect(
      readShipCheckRecord(
        record({ outcome: "couldNotRun", steps: [{ name: "Review", outcome: "failed", detail: "x" }] }),
      )?.outcome,
    ).toBe("failed");
  });

  it("falls back safely on missing or odd fields", () => {
    const got = readShipCheckRecord({
      head: HEAD,
      outcome: "failed",
      commitsCovered: -3,
      at: "yesterday",
      base: 12,
      note: 5,
      steps: "none",
      tested: ["ran", 7, "", "  "],
      notTested: { 0: "x" },
    });
    expect(got).toEqual({
      project: "",
      head: HEAD,
      base: null,
      commitsCovered: 0,
      at: 0,
      outcome: "failed",
      note: null,
      steps: [],
      tested: ["ran"],
      notTested: [],
    });
  });

  it("keeps a step's command and output tail only when they are text", () => {
    const got = readShipCheckRecord(
      record({
        steps: [
          { name: "Project checks", outcome: "passed", detail: "ok", command: "npm run check", outputTail: "12 passed" },
          { name: "Review", outcome: "passed", detail: "ok", command: 5 as unknown as string },
        ],
      }),
    );
    expect(got?.steps[0].command).toBe("npm run check");
    expect(got?.steps[0].outputTail).toBe("12 passed");
    expect(got?.steps[1].command).toBeUndefined();
  });
});

describe("running it", () => {
  it("runs once for the project and returns the record", async () => {
    const api = backend();
    const got = await runShipCheck("/work/app", api);
    expect(got.head).toBe(HEAD);
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.run).toHaveBeenCalledWith("/work/app");
    expect(shipCheckRunning("/work/app")).toBe(false);
  });

  it("starts no second run while one is out, however it is asked, and shares its answer", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const api = backend({ run: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    const first = runShipCheck("/work/app", api);
    expect(shipCheckRunning("/work/app")).toBe(true);
    // The same folder written another way is the same project.
    const second = runShipCheck("/work/app/", api);
    expect(api.run).toHaveBeenCalledTimes(1);
    finish(record());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(shipCheckRunning("/work/app")).toBe(false);
    // Once it is over, a new run starts.
    const third = runShipCheck("/work/app", api);
    expect(api.run).toHaveBeenCalledTimes(2);
    finish(record());
    await third;
  });

  it("runs two projects side by side", async () => {
    const api = backend({ run: vi.fn(() => new Promise(() => undefined)) });
    void runShipCheck("/work/one", api);
    void runShipCheck("/work/two", api);
    expect(api.run).toHaveBeenCalledTimes(2);
    expect(shipCheckRunning("/work/one")).toBe(true);
    expect(shipCheckRunning("/work/two")).toBe(true);
    expect(shipCheckRunning("/work/three")).toBe(false);
  });

  it("frees the project when the run fails, and says why in the app's words", async () => {
    const api = backend({
      run: vi.fn(async () => {
        throw "Another ship check is already running for this project.";
      }),
    });
    await expect(runShipCheck("/work/fail", api)).rejects.toThrow("Another ship check is already running");
    expect(shipCheckRunning("/work/fail")).toBe(false);
    await expect(runShipCheck("/work/fail", api)).rejects.toThrow();
    expect(api.run).toHaveBeenCalledTimes(2);
  });

  it("frees the project when the app throws at once instead of returning a rejected promise", async () => {
    const api = backend({
      run: vi.fn(() => {
        throw new Error("The app isn't ready.");
      }) as unknown as ShipCheckBackend["run"],
    });
    await expect(runShipCheck("/work/sync", api)).rejects.toThrow("The app isn't ready.");
    expect(shipCheckRunning("/work/sync")).toBe(false);
    await expect(runShipCheck("/work/sync", api)).rejects.toThrow("The app isn't ready.");
    expect(api.run).toHaveBeenCalledTimes(2);
  });

  it("refuses an answer it can't read instead of showing a made-up result", async () => {
    const api = backend({ run: vi.fn(async () => ({ outcome: "passed" })) });
    await expect(runShipCheck("/work/odd", api)).rejects.toThrow("couldn't be read");
    expect(shipCheckRunning("/work/odd")).toBe(false);
  });
});

describe("hearing of runs started elsewhere", () => {
  it("tells a listener when a run starts and when it settles, with the folder and the result", async () => {
    const events: unknown[] = [];
    const off = subscribeShipChecks((event) => events.push(event));
    let finish: (value: unknown) => void = () => undefined;
    const api = backend({ run: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    const run = runShipCheck("/work/notify", api);
    expect(events).toEqual([{ phase: "started", cwd: "/work/notify" }]);
    finish(record());
    await run;
    expect(events).toEqual([
      { phase: "started", cwd: "/work/notify" },
      { phase: "settled", cwd: "/work/notify", record: record(), error: null },
    ]);
    off();
  });

  it("says why a run failed when it settles, and is told nothing for a second ask that joined the run", async () => {
    const events: { phase: string; error?: string | null }[] = [];
    const off = subscribeShipChecks((event) => events.push(event));
    const api = backend({
      run: vi.fn(async () => {
        throw "Another ship check is already running for this project.";
      }),
    });
    const first = runShipCheck("/work/notify-fail", api);
    void runShipCheck("/work/notify-fail", api).catch(() => undefined);
    await expect(first).rejects.toThrow();
    expect(events.map((event) => event.phase)).toEqual(["started", "settled"]);
    expect(events[1].error).toBe("Another ship check is already running for this project.");
    off();
  });

  it("stops telling a listener once it has unsubscribed, and one that throws doesn't stop the rest", async () => {
    const heard: string[] = [];
    const off = subscribeShipChecks(() => heard.push("first"));
    subscribeShipChecks(() => {
      throw new Error("a bad listener");
    });
    const offThird = subscribeShipChecks(() => heard.push("third"));
    await runShipCheck("/work/notify-off", backend());
    expect(heard).toEqual(["first", "third", "first", "third"]);
    off();
    offThird();
    await runShipCheck("/work/notify-off", backend());
    expect(heard).toEqual(["first", "third", "first", "third"]);
  });
});

describe("the latest record", () => {
  it("is the app's record when it is readable and none when there is not one", async () => {
    expect((await latestShipCheck("/work/app", backend({ latest: vi.fn(async () => record()) })))?.head).toBe(HEAD);
    expect(await latestShipCheck("/work/app", backend({ latest: vi.fn(async () => null) }))).toBeNull();
    expect(await latestShipCheck("/work/app", backend({ latest: vi.fn(async () => ({ junk: true })) }))).toBeNull();
  });

  it("lets a failed read be told apart from no record", async () => {
    await expect(
      latestShipCheck("/work/app", backend({ latest: vi.fn(async () => Promise.reject("gone")) })),
    ).rejects.toThrow("gone");
  });
});
