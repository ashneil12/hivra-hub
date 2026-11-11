import { describe, expect, it } from "vitest";
import { crewRows, howLong, httpsUrl, settleLoad, workersUnder, type CrewWorkerInput } from "./rows";
import { STATUS_WORDS } from "./words";

const NOW = 1_700_000_000_000;
const PROJECT = "/work/proj";

function worker(patch: Partial<CrewWorkerInput> & { id: string }): CrewWorkerInput {
  return {
    project: PROJECT,
    title: patch.id,
    createdAt: NOW - 5 * 60_000,
    updatedAt: NOW,
    ...patch,
  };
}

function rows(list: CrewWorkerInput[]) {
  return crewRows({ project: PROJECT, rows: list, now: NOW });
}

describe("how long", () => {
  it("never shows a negative span, and a missing clock shows nothing", () => {
    expect(howLong(NOW, NOW - 10 * 60_000)).toBe("under a minute");
    expect(howLong(Number.NaN, NOW)).toBe("");
    expect(howLong(NOW, Number.POSITIVE_INFINITY)).toBe("");
    expect(howLong(NOW, NOW)).toBe("under a minute");
    expect(howLong(NOW, NOW + 60_000)).toBe("1 min");
    expect(howLong(NOW, NOW + 59 * 60_000)).toBe("59 min");
    expect(howLong(NOW, NOW + 60 * 60_000)).toBe("1 hour");
    expect(howLong(NOW, NOW + 47 * 60 * 60_000)).toBe("47 hours");
    expect(howLong(NOW, NOW + 48 * 60 * 60_000)).toBe("2 days");
  });
});

describe("crew rows", () => {
  it("shows one row per status, and only those words", () => {
    const shown = rows([
      worker({ id: "a", status: "working", childSession: "s-a" }),
      worker({ id: "b", status: "needs-you" }),
      worker({ id: "c", status: "done", settledAt: NOW }),
      worker({ id: "d", status: "failed" }),
      worker({ id: "e", status: "paused" }),
    ]);
    expect(shown.map((row) => row.statusWord)).toEqual([
      "working",
      "needs you",
      "done",
      "failed",
      "paused",
    ]);
    for (const row of shown) {
      expect(STATUS_WORDS).toContain(row.statusWord);
    }
  });

  it("does not invent a status from a row's own state, or from a word it does not know", () => {
    const shown = rows([
      worker({ id: "gone", status: "cancelled", title: "Stopped somewhere" }),
      worker({ id: "blank", title: "No status yet" }),
      { id: "state-only", project: PROJECT, title: "Looks failed", state: "failed" } as CrewWorkerInput,
    ]);
    expect(shown.map((row) => row.statusWord)).toEqual([null, null, null]);
    expect(shown.some((row) => /stuck|error|running|cancelled/i.test(row.statusWord ?? ""))).toBe(false);
  });

  it("keeps the newer copy when the same id arrives twice", () => {
    const shown = rows([
      worker({ id: "same", title: "Old", status: "working", updatedAt: 1 }),
      worker({ id: "same", title: "New", status: "done", updatedAt: 2, settledAt: NOW }),
      worker({ id: "same", title: "Tied later", status: "failed", updatedAt: 2 }),
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Tied later");
    expect(shown[0]?.statusWord).toBe("failed");
  });

  it("matches the project folder, including Windows paths, spaces, unicode and a trailing slash", () => {
    const project = "C:/Users/Ash/My Project/日本語";
    const shown = crewRows({
      project: `${project}/`,
      now: NOW,
      rows: [
        worker({ id: "in", project: "C:\\Users\\Ash\\My Project\\日本語", title: "In" }),
        worker({ id: "crlf", project: `c:/users/ash/my project/日本語\r\n`, title: "Crlf" }),
        worker({ id: "other", project: `${project}/other`, title: "Other" }),
        worker({ id: "dot", project: "/a/../b", title: "Not resolved" }),
        worker({ id: "empty", project: "", title: "Empty" }),
        worker({ id: "missing", project: null, title: "Missing" }),
      ],
    });
    expect(shown.map((row) => row.id).sort()).toEqual(["crlf", "in"]);
  });

  it("does not treat a lookalike path, or no project, as this project", () => {
    expect(rows([worker({ id: "up", project: "/work/proj/../other" })])).toEqual([]);
    expect(crewRows({ project: "", rows: [worker({ id: "a" })], now: NOW })).toEqual([]);
    expect(crewRows({ project: "~", rows: [worker({ id: "a", project: "~" })], now: NOW })).toEqual([]);
    expect(crewRows({ project: "  ", rows: [worker({ id: "a" })], now: NOW })).toEqual([]);
  });

  it("skips a brief's own row and an empty or repeated id", () => {
    const shown = rows([
      worker({ id: "lead-row", follow: "lead", status: "working", title: "The brief" }),
      worker({ id: "  ", title: "Blank id" }),
      worker({ id: "ok", status: "working" }),
    ]);
    expect(shown.map((row) => row.id)).toEqual(["ok"]);
  });

  it("filters to one brief without following a cycle, and keeps a title that looks like a path", () => {
    const list = [
      worker({ id: "brief", follow: "lead", title: "Fix the save bug" }),
      worker({ id: "child", parentId: "brief", status: "working", title: "../not/a/path" }),
      worker({ id: "grand", parentId: "child", status: "needs-you", project: "/elsewhere" }),
      worker({ id: "other", parentId: "someone", status: "done" }),
      worker({ id: "loop", parentId: "grand", status: "paused" }),
    ];
    list.push(worker({ id: "brief", parentId: "loop", title: "Back" }));
    const shown = crewRows({ project: PROJECT, rows: list, now: NOW, briefId: "brief" });
    expect(shown.map((row) => row.id)).toEqual(["child", "loop"]);
    expect(shown[0]?.title).toBe("../not/a/path");
    expect(crewRows({ project: PROJECT, rows: list, now: NOW, briefId: "missing" })).toEqual([]);
  });

  it("counts a finished row to when it settled, and a live row to now", () => {
    const shown = rows([
      worker({ id: "live", status: "working", createdAt: NOW - 2 * 60_000 }),
      worker({
        id: "old",
        status: "done",
        createdAt: NOW - 10 * 60_000,
        settledAt: NOW - 8 * 60_000,
        updatedAt: NOW,
      }),
    ]);
    expect(shown.find((row) => row.id === "live")?.howLong).toBe("2 min");
    expect(shown.find((row) => row.id === "old")?.howLong).toBe("2 min");
  });

  it("offers the actions that match the status, and will not land the project's own folder", () => {
    const shown = crewRows({
      project: PROJECT,
      now: NOW,
      sessions: [
        { id: "chat", harness: "claude", model: "opus", branch: "fix", additions: 3, deletions: 1, cwd: PROJECT },
        { id: "copy-chat", cwd: "/work/copies/fix", worktreeCwd: "/work/copies/fix" },
      ],
      deliveries: [
        { delegationId: "landed", state: "merged", url: "https://github.com/a/b/pull/4", updatedAt: 2 },
        { delegationId: "local", mode: "local", state: "ready", checkout: "/work/copies/fix", branch: "fix-save", updatedAt: 2 },
        { delegationId: "main", mode: "local", state: "ready", checkout: `${PROJECT}/`, updatedAt: 2 },
        {
          delegationId: "pr",
          mode: "pr",
          state: "ready",
          checkout: "/work/copies/pr",
          url: "javascript:alert(1)",
          number: 9,
          updatedAt: 3,
        },
      ],
      checks: [
        { url: "https://github.com/a/b/pull/4", number: 4, pending: 0, failed: [], passed: true, checks: 2 },
        { number: 9, repo: "a/b", pending: 1, failed: [], passed: false, checks: 1 },
        { number: 9, repo: "other/b", pending: 0, failed: ["lint"], passed: false, checks: 1 },
      ],
      rows: [
        worker({ id: "live", status: "working", childSession: "chat", ownerSession: "lead" }),
        worker({ id: "ask", status: "needs-you", childSession: "chat", ownerSession: "lead" }),
        worker({ id: "wait", status: "paused" }),
        worker({ id: "broke", status: "failed", childSession: "chat", ownerSession: "lead" }),
        worker({ id: "landed", status: "done", childSession: "chat" }),
        worker({ id: "local", status: "done", childSession: "copy-chat" }),
        worker({ id: "main", status: "done", childSession: "chat" }),
        worker({ id: "pr", status: "done", childSession: "copy-chat" }),
      ],
    });
    const byId = Object.fromEntries(shown.map((row) => [row.id, row]));
    expect(byId.live?.actions).toEqual(["open", "message", "stop"]);
    expect(byId.ask?.actions).toEqual(["open", "message", "stop"]);
    // A paused worker resumes by itself. Retry would start a second one on the same brief.
    expect(byId.wait?.actions).toEqual(["stop"]);
    expect(byId.wait?.actions).not.toContain("retry");
    expect(byId.broke?.actions).toEqual(["open", "retry"]);
    expect(byId.landed?.actions).toEqual(["open", "open-pr"]);
    expect(byId.landed?.checks).toBe("Every check passed");
    expect(byId.local?.actions).toContain("land");
    expect(byId.local?.branch).toBe("fix-save");
    expect(byId.main?.actions).not.toContain("land");
    expect(byId.pr?.actions).toContain("open-pr");
    expect(byId.pr?.prUrl).toBeNull();
    expect(byId.pr?.checks).toBeNull();
    expect(byId.live?.cli).toBe("claude");
    expect(byId.live?.model).toBe("opus");
    expect(byId.live?.additions).toBe(3);
    expect(byId.live?.deletions).toBe(1);
  });

  it("reads the first line of a title and ignores a harness or a diff it cannot trust", () => {
    const shown = crewRows({
      project: PROJECT,
      now: NOW,
      sessions: [
        { id: "s", harness: "not a cli", model: "x".repeat(90), additions: -1, deletions: Number.NaN, branch: "" },
      ],
      rows: [worker({ id: "t", childSession: "s", title: "First line\r\nSecond" })],
    });
    expect(shown[0]?.title).toBe("First line");
    expect(shown[0]?.cli).toBeNull();
    expect(shown[0]?.model).toBeNull();
    expect(shown[0]?.additions).toBeNull();
    expect(shown[0]?.deletions).toBeNull();
  });

  it("says when checks are running, failing, or not started", () => {
    const shown = crewRows({
      project: PROJECT,
      now: NOW,
      deliveries: [
        { delegationId: "run", url: "https://github.com/a/b/pull/1", number: 1, updatedAt: 1 },
        { delegationId: "bad", url: "https://github.com/a/b/pull/2", number: 2, updatedAt: 1 },
        { delegationId: "none", url: "https://github.com/a/b/pull/3", number: 3, updatedAt: 1 },
      ],
      checks: [
        { url: "https://github.com/a/b/pull/1", pending: 2, failed: [], passed: false, checks: 2 },
        { url: "https://github.com/a/b/pull/2", pending: 0, failed: ["test"], passed: false, checks: 1 },
        { url: "https://github.com/a/b/pull/3", pending: 0, failed: [], passed: false, checks: 0 },
      ],
      rows: [
        worker({ id: "run", status: "working" }),
        worker({ id: "bad", status: "working" }),
        worker({ id: "none", status: "working" }),
      ],
    });
    const byId = Object.fromEntries(shown.map((row) => [row.id, row.checks]));
    expect(byId).toEqual({
      run: "2 checks still going",
      bad: "1 check did not pass",
      none: "No checks yet",
    });
  });

  it("hides a secret or a stack the same way a failure does, and shows the plain line", () => {
    const shown = rows([
      worker({ id: "secret", status: "failed", statusNotice: "The key is sk-live-secret" }),
      worker({ id: "stack", status: "failed", statusNotice: "at save (/tmp/a.ts:1)" }),
      worker({ id: "plain", status: "failed", statusNotice: "The save did not finish.\nsk-live-secret" }),
    ]);
    expect(shown.find((row) => row.id === "secret")?.notice).toBeNull();
    expect(shown.find((row) => row.id === "stack")?.notice).toBeNull();
    expect(shown.find((row) => row.id === "plain")?.notice).toBe("The save did not finish.");
  });

  it("keeps the last list when a refresh fails, and replaces it when the next one is empty", () => {
    const previous = rows([worker({ id: "a", status: "working" })]);
    expect(settleLoad(previous, { ok: false })).toEqual({ value: previous, stale: true });
    expect(settleLoad(previous, { ok: true, value: [] })).toEqual({ value: [], stale: false });
  });
});

describe("workers under a brief", () => {
  it("visits each id once when the same child is listed twice", () => {
    const child = { id: "c", parentId: "b" };
    expect(workersUnder("b", [child, child, { id: "b", parentId: "c" }]).map((row) => row.id)).toEqual(["c"]);
  });
});

describe("pull request links", () => {
  it("allows https only", () => {
    expect(httpsUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(httpsUrl("http://github.com/a/b/pull/1")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("")).toBeNull();
    expect(httpsUrl("not a url")).toBeNull();
  });
});

describe("WP-141: why the crew picked a worker", () => {
  it("shows the reason kept on the recorded line, beside the status notice, not instead of it", () => {
    const [row] = rows([
      worker({
        id: "w",
        status: "needs-you",
        statusNotice: "Asked its first mate",
        log: [{ event: "recorded", at: 1, by: "owner:m", why: "Builder role prefers Codex." }],
      }),
    ]);
    expect(row?.why).toBe("Builder role prefers Codex.");
    expect(row?.notice).toBe("Asked its first mate");
  });

  it("shows nothing for a row without one, and never a line that looks like a key", () => {
    const [plain, secret] = rows([
      worker({ id: "a", log: [{ event: "recorded", at: 1, by: "owner:m" }] }),
      worker({ id: "b", log: [{ event: "recorded", at: 1, by: "owner:m", why: "The key is sk-live-secret" }] }),
    ]);
    expect(plain).not.toHaveProperty("why");
    expect(secret).not.toHaveProperty("why");
  });
});

