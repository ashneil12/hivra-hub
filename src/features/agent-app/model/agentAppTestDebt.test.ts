// PT-5: the webview's half of test debt: what the app says follows a ship check is read defensively, the ONE test fixer task starts
// through the delegation path (and is given back when it can't start), and each Needs-you item is claimed first and filed once.
import { describe, expect, it, vi } from "vitest";
import { isAppDelegate } from "./agentAppTasks";
import {
  fileTestDebtAsks,
  readFixerRequest,
  readTestDebtFollow,
  startTestFixer,
  type FixerRequest,
  type TestDebtBackend,
  type TestDebtFollow,
} from "./agentAppTestDebt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const FIXER: FixerRequest = {
  token: "test-fixer-0123456-1700000000000",
  title: "Sort failing tests (2)",
  brief: "This project sorts failing tests at ship.\n\n## Tests to sort (2)",
  goal: "Every test on the brief has a decision in your report.",
  count: 2,
};

function backend(over: Partial<TestDebtBackend> = {}): TestDebtBackend {
  return {
    fixerClaim: vi.fn(async () => FIXER),
    fixerStarted: vi.fn(async () => true),
    fixerRelease: vi.fn(async () => true),
    claim: vi.fn(async () => ({ claimed: false, note: "already asked" })),
    release: vi.fn(async () => true),
    answer: vi.fn(async () => true),
    ...over,
  };
}

describe("readTestDebtFollow: what the app says follows a ship check", () => {
  it("reads whether the fixer is due, the real bugs and the tests to ask about", () => {
    const got = readTestDebtFollow({
      fixerDue: true,
      bugs: [{ key: "code-wrong:a:1", test: "adds up", file: "src/a.test.ts", line: "tax is ignored" }],
      proposals: [{ id: "vitest|a.test.ts|brittle", test: "brittle", broke: 5 }],
    });
    expect(got.fixerDue).toBe(true);
    expect(got.bugs).toEqual([{ key: "code-wrong:a:1", test: "adds up", file: "src/a.test.ts", line: "tax is ignored" }]);
    expect(got.proposals).toEqual([{ id: "vitest|a.test.ts|brittle", test: "brittle", broke: 5 }]);
  });

  it("reads nothing from an answer that is not an object, and drops each bad entry on its own", () => {
    for (const bad of [null, undefined, "x", 5, [], [{ fixerDue: true }]]) {
      expect(readTestDebtFollow(bad)).toEqual({ fixerDue: false, bugs: [], proposals: [] });
    }
    const got = readTestDebtFollow({
      fixerDue: "yes",
      bugs: [{ key: "", test: "x" }, { key: "k", test: "" }, null, { key: "ok", test: "fine" }, { key: "ok", test: "again" }],
      proposals: [{ id: "a", test: "t", broke: 0 }, { id: "b", test: "t", broke: 2.5 }, { id: "c", test: "t", broke: 6 }],
    });
    expect(got.fixerDue).toBe(false);
    expect(got.bugs.map((bug) => bug.key)).toEqual(["ok"]);
    expect(got.proposals.map((p) => p.id)).toEqual(["c"]);
  });

  it("keeps at most ten of each", () => {
    const bugs = Array.from({ length: 25 }, (_, n) => ({ key: `k${n}`, test: `t${n}` }));
    expect(readTestDebtFollow({ bugs }).bugs).toHaveLength(10);
  });
});

describe("readFixerRequest: the task the app claimed the slot for", () => {
  it("reads a whole request", () => {
    expect(readFixerRequest(FIXER)).toEqual(FIXER);
  });

  it("refuses one whose request id could not be a task's, whose brief is huge or whose count is not a number", () => {
    expect(readFixerRequest({ ...FIXER, token: "../x" })).toBeNull();
    expect(readFixerRequest({ ...FIXER, token: "has spaces" })).toBeNull();
    expect(readFixerRequest({ ...FIXER, brief: "x".repeat(30_001) })).toBeNull();
    expect(readFixerRequest({ ...FIXER, count: "2" })).toBeNull();
    expect(readFixerRequest({ ...FIXER, count: 0 })).toBeNull();
    expect(readFixerRequest({ ...FIXER, goal: "  " })).toBeNull();
    for (const bad of [null, undefined, "x", 5, []]) expect(readFixerRequest(bad)).toBeNull();
  });
});

describe("startTestFixer: the one fixer task", () => {
  it("claims the slot, then starts it as a normal worker task under the request id the app named", async () => {
    const delegate = vi.fn(async (_token: string, _input: Record<string, unknown>) => ({
      taskId: "task-9",
      childSessionId: `app-chat-1-${FIXER.token}`,
      status: "running",
    }));
    const b = backend();
    const out = await startTestFixer("/code/hivra", delegate, b);
    expect(b.fixerClaim).toHaveBeenCalledWith("/code/hivra");
    expect(delegate).toHaveBeenCalledTimes(1);
    const [token, input] = delegate.mock.calls[0];
    expect(token).toBe(FIXER.token);
    expect(input).toMatchObject({ brief: FIXER.brief, title: FIXER.title, goal: FIXER.goal });
    expect(String(input.intent)).toContain("2 failing tests");
    // A worker, not a first mate's own lead; and not a code brief, so a fixer that only decides is never sent back for no change.
    expect(input.lead).toBeUndefined();
    expect(input.code).toBeUndefined();
    expect(input.gates).toBeUndefined();
    // The app's own task: marked by the app (no agent can set the mark), so it is not told the at-ship worker sentence.
    expect(isAppDelegate(input)).toBe(true);
    expect(input.testFixer).toBe(true);
    expect(input.project).toBeUndefined();
    expect(b.fixerStarted).toHaveBeenCalledWith("/code/hivra", FIXER.token, `app-chat-1-${FIXER.token}`);
    expect(out).toMatchObject({ started: true, taskId: "task-9", title: FIXER.title });
    expect(out.note).toContain("carry on with the feature work");
  });

  it("starts nothing when the app says another fixer holds the project, or none is due", async () => {
    const delegate = vi.fn();
    for (const claimed of [null, undefined, "x", 5]) {
      const out = await startTestFixer("/code/hivra", delegate, backend({ fixerClaim: vi.fn(async () => claimed) }));
      expect(out.started).toBe(false);
      expect(out.note).toContain("already sorting");
    }
    expect(delegate).not.toHaveBeenCalled();
  });

  it("gives the slot back when the app's claim can't be read, by the request id it carries, and starts nothing", async () => {
    const delegate = vi.fn();
    const b = backend({ fixerClaim: vi.fn(async () => ({ ...FIXER, brief: "" })) });
    const out = await startTestFixer("/code/hivra", delegate, b);
    expect(out.started).toBe(false);
    expect(out.note).toContain("couldn't be read");
    expect(b.fixerRelease).toHaveBeenCalledWith("/code/hivra", FIXER.token);
    expect(delegate).not.toHaveBeenCalled();
    // A claim with no usable request id has nothing to give back.
    const none = backend({ fixerClaim: vi.fn(async () => ({ token: "bad token" })) });
    await startTestFixer("/code/hivra", delegate, none);
    expect(none.fixerRelease).not.toHaveBeenCalled();
  });

  it("says so when the app could not be asked, and starts nothing", async () => {
    const delegate = vi.fn();
    const out = await startTestFixer(
      "/code/hivra",
      delegate,
      backend({
        fixerClaim: vi.fn(async () => {
          throw new Error("the list is busy");
        }),
      }),
    );
    expect(out.started).toBe(false);
    expect(out.note).toContain("the list is busy");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("names the project when the first mate named one", async () => {
    const delegate = vi.fn(async (_token: string, _input: Record<string, unknown>) => ({ childSessionId: "app-c-1" }));
    await startTestFixer("/code/hivra", delegate, backend(), "/code/other");
    expect(delegate.mock.calls[0][1].project).toBe("/code/other");
  });

  it("gives the slot back when the task can't start, so the next ship check tries again", async () => {
    const delegate = vi.fn(async () => {
      throw new Error("claude is not available");
    });
    const b = backend();
    const out = await startTestFixer("/code/hivra", delegate, b);
    expect(out.started).toBe(false);
    expect(out.note).toContain("claude is not available");
    expect(out.note).toContain("the next ship check starts it again");
    expect(b.fixerRelease).toHaveBeenCalledWith("/code/hivra", FIXER.token);
    expect(b.fixerStarted).not.toHaveBeenCalled();
  });

  it("is still started when the app can't remember the child session: the claim's grace decides, never a second fixer", async () => {
    const delegate = vi.fn(async () => ({ childSessionId: "app-c-1", taskId: "t" }));
    const b = backend({
      fixerStarted: vi.fn(async () => {
        throw new Error("busy");
      }),
    });
    const out = await startTestFixer("/code/hivra", delegate, b);
    expect(out.started).toBe(true);
    expect(b.fixerRelease).not.toHaveBeenCalled();
  });

  it("reads a start that answers no child session as started with nothing to remember", async () => {
    const delegate = vi.fn(async () => "ok");
    const b = backend();
    const out = await startTestFixer("/code/hivra", delegate, b);
    expect(out).toMatchObject({ started: true, taskId: null });
    expect(b.fixerStarted).not.toHaveBeenCalled();
  });
});

describe("fileTestDebtAsks: each Needs-you item is claimed, then filed once", () => {
  const follow: TestDebtFollow = {
    fixerDue: false,
    bugs: [{ key: "code-wrong:a:1", test: "adds up", file: "a.test.ts", line: "tax is ignored" }],
    proposals: [{ id: "vitest|a.test.ts|brittle", test: "brittle", broke: 5 }],
  };

  const bugClaim = {
    claimed: true,
    key: "test-debt-bug-0123456789abcdef",
    question: "adds up fails because the code is wrong: tax is ignored",
    options: ["Fix it", "Not now"],
    recommended: "Fix it",
    note: "Asked the person.",
  };
  const proposalClaim = {
    claimed: true,
    key: "test-debt-score-0123456789abcdef",
    question: "brittle broke 5 times and never caught a bug. Rewrite it to test behaviour, or delete it?",
    options: ["Rewrite it", "Delete it", "Keep it"],
    recommended: "Rewrite it",
    note: "Asked the person.",
  };

  function claims() {
    return vi.fn(async (_cwd: string, kind: string) => (kind === "bug" ? bugClaim : proposalClaim));
  }

  it("files the real bug and the rewrite-or-delete question with the app's own words and choices", async () => {
    const ask = vi.fn(async (_input: Record<string, unknown>) => ({ state: "open" }));
    const out = await fileTestDebtAsks("/code/hivra", follow, ask, backend({ claim: claims() }));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0][0]).toEqual({
      key: bugClaim.key,
      question: "adds up fails because the code is wrong: tax is ignored",
      options: ["Fix it", "Not now"],
      recommended: "Fix it",
    });
    expect(ask.mock.calls[1][0]).toMatchObject({
      question: "brittle broke 5 times and never caught a bug. Rewrite it to test behaviour, or delete it?",
      options: ["Rewrite it", "Delete it", "Keep it"],
    });
    expect(out.map((one) => [one.kind, one.asked])).toEqual([
      ["bug", true],
      ["proposal", true],
    ]);
  });

  it("asks nothing for an item the app already put to the person (the claim says so)", async () => {
    const ask = vi.fn();
    const out = await fileTestDebtAsks("/code/hivra", follow, ask, backend());
    expect(ask).not.toHaveBeenCalled();
    expect(out.every((one) => !one.asked)).toBe(true);
  });

  it("gives a claim back when the question can't be filed, says so, and still tries the next", async () => {
    const release = vi.fn(async () => true);
    const ask = vi
      .fn()
      .mockRejectedValueOnce(new Error("the decision store is busy"))
      .mockResolvedValueOnce({ state: "open" });
    const out = await fileTestDebtAsks("/code/hivra", follow, ask, backend({ claim: claims(), release }));
    expect(release).toHaveBeenCalledWith("/code/hivra", "bug", "code-wrong:a:1");
    expect(out[0].asked).toBe(false);
    expect(out[0].note).toContain("The next ship check will ask again");
    expect(out[1].asked).toBe(true);
  });

  it("remembers an answer the ask came back with, so Keep it stands", async () => {
    const answer = vi.fn(async () => true);
    const ask = vi.fn(async (input: Record<string, unknown>) =>
      String(input.key).startsWith("test-debt-score") ? { state: "answered", answer: "Keep it" } : { state: "open" },
    );
    const out = await fileTestDebtAsks("/code/hivra", follow, ask, backend({ claim: claims(), answer }));
    expect(answer).toHaveBeenCalledWith("/code/hivra", "vitest|a.test.ts|brittle", "Keep it");
    expect(out[1].note).toContain('already answered "Keep it"');
  });

  it("files nothing from a claim it can't read, and says so instead of guessing", async () => {
    const ask = vi.fn();
    for (const bad of [null, "x", { claimed: true }, { ...bugClaim, options: ["only one"] }, { ...bugClaim, recommended: "Other" }]) {
      const out = await fileTestDebtAsks(
        "/code/hivra",
        { fixerDue: false, bugs: follow.bugs, proposals: [] },
        ask,
        backend({ claim: vi.fn(async () => bad) }),
      );
      expect(out[0].asked).toBe(false);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("never deletes a test: rewrite and delete are only choices the first mate hears", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./agentAppTestDebt.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/unlink|rmSync|rm\(|removeFile|deleteFile/);
  });
});
