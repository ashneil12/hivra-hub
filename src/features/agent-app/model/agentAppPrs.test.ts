// @vitest-environment happy-dom
// The PR watch's app actions (agentAppPrs.ts): who may watch, what a registration sends to pr_watch.rs and answers, and
// that a chat only ends and lists its own watches. The store is a stand-in with pr_watch.rs's owner rule.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import type { PrWatch, PrWatchAddInput } from "../../pr-watch/model/prWatches";
import { handleAgentApp, type AgentAppHost } from "./agentApp";
import type { AgentAppPrsHost } from "./agentAppPrs";

beforeEach(() => {
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
}));

const storedValues = new Map<string, string>();
vi.stubGlobal("localStorage", {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

const PROJECT = "/code/hivra";

function watchRow(patch: Partial<PrWatch> = {}): PrWatch {
  return {
    id: "w1",
    ownerSession: "mono-hivra",
    ownerMono: "hivra-lead",
    ownerName: "Hivra lead",
    repo: "ashneil12/hivra",
    number: 42,
    url: "https://github.com/ashneil12/hivra/pull/42",
    title: "Fix the save bug",
    project: "hivra",
    worktree: null,
    repoRoot: PROJECT,
    askIds: [],
    state: "watching",
    endReason: null,
    status: {
      pr: "open",
      draft: false,
      required: true,
      checks: 3,
      pending: 2,
      failed: [],
      passed: false,
      mergeable: "mergeable",
      reviewDecision: "REVIEW_REQUIRED",
    },
    headSha: "936921fa9e67cdbf78fb25abc6252afabafef056",
    headRef: "fix/save",
    baseRef: "canary",
    mergeSha: null,
    readFailures: 0,
    lastError: null,
    lastReadAt: 1_000,
    nextReadAt: 121_000,
    wakesTotal: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    endedAt: null,
    ...patch,
  };
}

function prsHost(watches: PrWatch[]) {
  const added: PrWatchAddInput[] = [];
  const api: AgentAppPrsHost = {
    add: vi.fn(async (input: PrWatchAddInput) => {
      added.push(input);
      const existing = watches.find(
        (w) => w.ownerSession === input.ownerSession && w.repo === input.repo && w.number === input.number,
      );
      const watch = existing ?? watchRow({ ownerSession: input.ownerSession, repo: input.repo, number: input.number });
      if (!existing) watches.push(watch);
      return { watch, wasWatching: !!existing, checkout: "a worktree mc/pr-42 made from /code/hivra" };
    }),
    remove: vi.fn(async (input) => {
      const mine = watches.filter(
        (w) =>
          w.ownerSession === input.ownerSession &&
          w.state === "watching" &&
          (!input.repo || w.repo.toLowerCase() === input.repo.toLowerCase()) &&
          (!input.number || w.number === input.number),
      );
      for (const w of mine) {
        w.state = "ended";
        w.endReason = input.reason ?? "unwatched";
      }
      return mine;
    }),
    list: vi.fn(async (owner) => watches.filter((w) => w.ownerSession === owner)),
    hubProjectId: (folder) => (folder === PROJECT ? "hivra" : undefined),
  };
  return { api, added };
}

function fixture(
  watches: PrWatch[] = [],
  who: "mono" | "plain" | "habit" | "checker" | "worker" | "team" = "mono",
) {
  const source: Session = {
    ...newSession("claude", PROJECT, "claude:opus-5-5"),
    id: who === "worker" ? "app-mono-hivra-r0" : who === "checker" ? "mono-checker" : who === "team" ? "team-hivra" : "mono-hivra",
  };
  const prs = prsHost(watches);
  const host = {
    isMono: () => who === "mono" || who === "checker",
    isHabitRun: () => who === "habit",
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: PROJECT } : undefined),
    monoOf: () =>
      who === "plain" || who === "worker" || who === "team"
        ? undefined
        : {
            id: who === "checker" ? "checker" : "hivra-lead",
            name: who === "checker" ? "Checker" : "Hivra lead",
            projects: [PROJECT, "/code/site"],
          },
    prs: prs.api,
  } as unknown as AgentAppHost;
  return { source, host, ...prs };
}

describe("prs.watch", () => {
  it("registers the pull request for the Mono's chat with its projects, worktree and asks", async () => {
    const { source, host, added } = fixture();
    const result = (await handleAgentApp(
      source,
      "r1",
      "prs.watch",
      { repo: "ashneil12/hivra", number: 42, worktree: "/w/hivra-fix", asks: ["a_1", "a_2", "a_1"] },
      host,
    )) as Record<string, unknown>;
    expect(added).toEqual([
      {
        ownerSession: "mono-hivra",
        ownerMono: "hivra-lead",
        ownerName: "Hivra lead",
        repo: "ashneil12/hivra",
        number: 42,
        worktree: "/w/hivra-fix",
        projects: [{ folder: PROJECT, hubId: "hivra" }, { folder: "/code/site" }],
        askIds: ["a_1", "a_2"],
      },
    ]);
    expect(result).toMatchObject({
      repo: "ashneil12/hivra",
      number: 42,
      watching: true,
      wasWatching: false,
      now: "1 of 3 required checks done",
      checks: { gate: "required", total: 3, pending: 2, passed: false },
      checkout: "a worktree mc/pr-42 made from /code/hivra",
    });
    expect(result.note).toContain("Tell Ash in one line that you're waiting on CI and end your turn; don't poll.");
    expect(result.note).not.toContain("already needs a fix");
  });

  it("registers it for a coding-team chat too, as its coding team, on its own project", async () => {
    const { source, host, added } = fixture([], "team");
    await handleAgentApp(source, "r1", "prs.watch", { repo: "ashneil12/hivra", number: 42 }, host);
    expect(added).toEqual([
      {
        ownerSession: "team-hivra",
        ownerName: "Hivra coding team",
        repo: "ashneil12/hivra",
        number: 42,
        projects: [{ folder: PROJECT, hubId: "hivra" }],
      },
    ]);
  });

  it("says when what the pull request shows now already needs a fix", async () => {
    const red = watchRow({
      ownerSession: "mono-hivra",
      status: { ...watchRow().status, pending: 0, failed: ["CI / build"] },
    });
    const { source, host } = fixture([red]);
    const result = (await handleAgentApp(source, "r2", "prs.watch", { repo: "ashneil12/hivra", number: 42 }, host)) as Record<
      string,
      unknown
    >;
    expect(result.wasWatching).toBe(true);
    expect(result.now).toBe("1 required check failed");
    expect(result.checks).toMatchObject({ failed: ["CI / build"] });
    expect(result.note).toContain("It already needs a fix: deal with it in this turn");
  });

  it("refuses a worker, a habit run, a plain chat and the checker", async () => {
    for (const [who, words] of [
      ["worker", "A worker reports its pull request to the chat that delegated it"],
      ["plain", "Only a Mono's own chat or a chat in a project's coding team can watch pull requests"],
      ["habit", "A habit run can't watch a pull request"],
      ["checker", "The checker only reads"],
    ] as const) {
      const { source, host, added } = fixture([], who);
      await expect(
        handleAgentApp(source, "r", "prs.watch", { repo: "o/r", number: 1 }, host),
      ).rejects.toThrow(words);
      expect(added).toEqual([]);
    }
  });

  it("checks its fields before anything is read", async () => {
    const { source, host, added } = fixture();
    for (const [input, words] of [
      [{ repo: "not a repo", number: 1 }, 'repo must be "owner/name"'],
      [{ repo: "o/r", number: 0 }, "number must be the pull request's number"],
      [{ repo: "o/r", number: 1.5 }, "number must be the pull request's number"],
      [{ repo: "o/r", number: 1, asks: ["x"] }, "asks must be up to 50 Ash OS ask ids"],
      [{ repo: "o/r", number: 1, worktree: "relative/path" }, "worktree must be the full path"],
      [{ repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1" }, "Unknown prs.watch fields: url"],
    ] as const) {
      await expect(handleAgentApp(source, "r", "prs.watch", { ...input }, host)).rejects.toThrow(words);
    }
    expect(added).toEqual([]);
  });
});

describe("prs.unwatch and prs.status", () => {
  it("ends only the caller's own watch, and says so when there is none", async () => {
    const theirs = watchRow({ id: "w2", ownerSession: "mono-other" });
    const mine = watchRow();
    const { source, host } = fixture([mine, theirs]);
    await expect(
      handleAgentApp(source, "r", "prs.unwatch", { repo: "ashneil12/hivra", number: 42 }, host),
    ).resolves.toEqual({ repo: "ashneil12/hivra", number: 42, watching: false });
    expect(mine.endReason).toBe("unwatched");
    expect(theirs.state).toBe("watching");
    await expect(
      handleAgentApp(source, "r", "prs.unwatch", { repo: "ashneil12/hivra", number: 42 }, host),
    ).rejects.toThrow("You aren't watching ashneil12/hivra#42");
  });

  it("lists the caller's watches with their checks, checkout and how they ended", async () => {
    const merged = watchRow({
      id: "w3",
      number: 41,
      state: "ended",
      endReason: "merged",
      mergeSha: "feedface",
      askIds: ["a_9"],
      worktree: "/w/hivra-pr-41",
    });
    const { source, host } = fixture([watchRow(), merged, watchRow({ id: "w9", ownerSession: "mono-other", number: 7 })]);
    const result = (await handleAgentApp(source, "r", "prs.status", {}, host)) as {
      watches: Record<string, unknown>[];
    };
    expect(result.watches.map((w) => w.number)).toEqual([42, 41]);
    expect(result.watches[1]).toMatchObject({
      state: "ended",
      ended: "merged",
      now: "Merged",
      mergeSha: "feedface",
      asks: ["a_9"],
      worktree: "/w/hivra-pr-41",
    });
    const empty = fixture([]);
    await expect(handleAgentApp(empty.source, "r", "prs.status", {}, empty.host)).resolves.toMatchObject({
      watches: [],
      note: "You aren't watching any pull request. pr_watch registers one.",
    });
  });
});
