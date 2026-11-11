import { describe, expect, it } from "vitest";
// The WP-155 helper the lead runs by hand. The tick keeps the same never-merge rule.
import { NEVER_MERGE_PACKAGES as HELPER_PACKAGES, securityParkReason } from "../../../../scripts/hivra-ship-green.mjs";
import type { ProgrammePackage, ProgrammeStatus } from "../../programme/model/programme";
import neverMergeList from "./neverMerge.json";
import { NEVER_MERGE_PACKAGES, NOTED_KEY_MAX, neverMergeReason, runLeadTick, tickRequestId, type LeadTickPorts, type TickWatch } from "./tick";

const NOW = 1_000_000_000;
const HOUR = 60 * 60 * 1000;

function row(patch: Partial<ProgrammePackage>): ProgrammePackage {
  return {
    id: "r1",
    projectId: "app",
    wp: "WP-200",
    title: "Build the thing",
    briefPath: "docs/hivra/work/WP-200.md",
    branch: "wp/200-thing",
    status: "queued",
    securityPark: false,
    priority: 0,
    notes: "",
    parkReason: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    claimedAt: null,
    finishedAt: null,
    ...patch,
  };
}

function watch(patch: Partial<TickWatch> & { status?: Partial<TickWatch["status"]> }): TickWatch {
  const { status, ...rest } = patch;
  return {
    repo: "owner/app",
    number: 7,
    title: "WP-200: build the thing",
    headRef: "wp/200-thing",
    headSha: "abc1234",
    project: "app",
    state: "watching",
    endReason: null,
    endedAt: null,
    ...rest,
    status: {
      pr: "open",
      draft: false,
      checks: 3,
      pending: 0,
      failed: [],
      passed: true,
      mergeable: "mergeable",
      labels: [],
      ...status,
    },
  };
}

type Fake = LeadTickPorts & {
  calls: string[];
  rows: ProgrammePackage[];
  notes: string[];
  outcomes: string[];
};

function fake(options: {
  rows?: ProgrammePackage[];
  watches?: TickWatch[];
  slot?: { ok: true } | { ok: false; reason: string };
  merge?: Awaited<ReturnType<LeadTickPorts["merge"]>>;
  delegateFails?: boolean;
  listFails?: boolean;
  watchesFail?: boolean;
}): Fake {
  const state: Fake = {
    calls: [],
    rows: options.rows ?? [],
    notes: [],
    outcomes: [],
    async list() {
      state.calls.push("list");
      if (options.listFails) throw new Error("db busy");
      return state.rows.map((r) => ({ ...r }));
    },
    async setStatus(id, version, status: ProgrammeStatus) {
      state.calls.push(`status ${id} ${status}`);
      const found = state.rows.find((r) => r.id === id);
      if (!found || found.version !== version) throw new Error("This package changed.");
      found.status = status;
      found.version += 1;
      return { ...found };
    },
    slot(inFlight) {
      state.calls.push(`slot ${inFlight}`);
      return options.slot ?? { ok: true };
    },
    async delegate(requestId, input) {
      state.calls.push(`delegate ${requestId} ${String(input.title)}`);
      if (options.delegateFails) throw new Error("no worker");
      return { taskId: "t1", status: "running" };
    },
    async watches() {
      state.calls.push("watches");
      if (options.watchesFail) throw new Error("watch list busy");
      return options.watches ?? [];
    },
    async merge(repo, number) {
      state.calls.push(`merge ${repo}#${number}`);
      return options.merge ?? { outcome: "merged", headSha: "abc1234", allowedBy: "project setting: merge without asking" };
    },
    note(line) {
      state.notes.push(line);
    },
    outcome(line) {
      state.outcomes.push(line);
    },
  };
  return state;
}

const base = { folder: "/code/app", shipOnGreen: false, noted: [] as string[], now: NOW };

describe("lead tick step (a): read the programme", () => {
  it("reads the board and says so plainly when it can't", async () => {
    const ports = fake({ listFails: true });
    const result = await runLeadTick(base, ports);
    expect(result.line).toBe("Couldn't read the programme. The next tick tries again.");
    expect(ports.calls).toEqual(["list"]);
  });

  it("with nothing on the programme, does nothing", async () => {
    const ports = fake({});
    const result = await runLeadTick(base, ports);
    expect(result.line).toBe("Nothing on the programme.");
    expect(ports.calls.filter((c) => c.startsWith("delegate") || c.startsWith("merge"))).toEqual([]);
  });
});

describe("lead tick step (b): start the next package", () => {
  it("claims the first queued package and delegates its brief when a builder slot is free", async () => {
    const ports = fake({ rows: [row({ id: "a", wp: "WP-201", title: "First", priority: 5 }), row({ id: "b", wp: "WP-202", title: "Second" })] });
    const result = await runLeadTick(base, ports);
    expect(ports.calls).toContain("status a building");
    expect(ports.calls).toContain(`delegate ${tickRequestId("a", 2)} WP-201: First`);
    expect(ports.calls.some((c) => c.startsWith("status b"))).toBe(false);
    expect(ports.rows[0].status).toBe("building");
    expect(result.line).toContain("Started WP-201");
  });

  it("starts one package per tick", async () => {
    const ports = fake({ rows: [row({ id: "a" }), row({ id: "b" })] });
    await runLeadTick(base, ports);
    expect(ports.calls.filter((c) => c.startsWith("delegate"))).toHaveLength(1);
  });

  it("hands the worker the brief path, the branch and a definition of done", async () => {
    let input: Record<string, unknown> = {};
    const ports = fake({ rows: [row({})] });
    ports.delegate = async (_id, given) => {
      input = given;
      return { status: "waiting" };
    };
    const result = await runLeadTick(base, ports);
    expect(String(input.brief)).toContain("docs/hivra/work/WP-200.md");
    expect(String(input.brief)).toContain("wp/200-thing");
    expect(String(input.intent).trim()).not.toBe("");
    expect(String(input.goal)).toContain("wp/200-thing");
    expect(input.project).toBe("/code/app");
    expect(input.isolation).toBe("worktree");
    // A brief held for a fresh-eyes review answers "waiting": it stays claimed and the line says so.
    expect(result.line).toContain("waiting for a fresh-eyes review");
  });

  it("starts nothing when no builder slot is free, and says why", async () => {
    const ports = fake({ rows: [row({})], slot: { ok: false, reason: "Paused: load is high." } });
    const result = await runLeadTick(base, ports);
    expect(ports.calls.some((c) => c.startsWith("delegate") || c.includes("building"))).toBe(false);
    expect(result.line).toContain("Paused: load is high.");
  });

  it("counts packages already building against the slot", async () => {
    const ports = fake({ rows: [row({ id: "x", status: "building" }), row({ id: "y", status: "pr_open", branch: "b2" }), row({ id: "q" })] });
    await runLeadTick(base, ports);
    expect(ports.calls).toContain("slot 1");
  });

  it("never starts a security-parked or parked package", async () => {
    const ports = fake({ rows: [row({ id: "s", securityPark: true }), row({ id: "p", status: "parked" })] });
    await runLeadTick(base, ports);
    expect(ports.calls.some((c) => c.startsWith("delegate") || c.includes("building"))).toBe(false);
  });

  it("marks the package failed when the delegate call fails", async () => {
    const ports = fake({ rows: [row({ id: "a" })], delegateFails: true });
    const result = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("failed");
    expect(result.line).toContain("Couldn't start WP-200");
  });

  it("leaves a package another window claimed first", async () => {
    const ports = fake({ rows: [row({ id: "a" })] });
    ports.setStatus = async () => {
      throw new Error("This package changed.");
    };
    await runLeadTick(base, ports);
    expect(ports.calls.some((c) => c.startsWith("delegate"))).toBe(false);
  });
});

describe("lead tick step (c): read CI for programme pull requests", () => {
  it("moves a building package to review when its pull request is open", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building" })], watches: [watch({ status: { passed: false, pending: 2 } })], slot: { ok: false, reason: "full" } });
    const result = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("pr_open");
    expect(result.line).toContain("WP-200 is in review (#7)");
  });

  it("marks a package merged when its pull request merged and writes one outcome line", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ state: "ended", endReason: "merged", status: { pr: "merged" } })] });
    await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("merged");
    expect(ports.outcomes).toEqual(["Merged WP-200: Build the thing (#7)."]);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("matches a pull request to its package whatever the case of the branch name", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building", branch: "wp/200-Thing" })], watches: [watch({ headRef: "wp/200-thing" })] });
    await runLeadTick(base, ports);
    expect(ports.calls).toContain("status a pr_open");
  });

  it("never acts on a merged package, even with a green pull request and Ship on green on", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "merged" })], watches: [watch({})] });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.filter((c) => c.startsWith("merge") || c.startsWith("status") || c.startsWith("delegate"))).toEqual([]);
    expect(result.line).toBe("Nothing on the programme.");
  });

  it("reports a red CI in the line once per head, and never as a ping (the PR watch already sends ci-red)", async () => {
    const rows = [row({ id: "a", status: "pr_open" })];
    const red = [watch({ status: { passed: false, failed: ["test"] } })];
    const first = await runLeadTick(base, fake({ rows, watches: red }));
    expect(first.attention).toEqual([]);
    expect(first.line).toContain("CI failed on #7 (WP-200): test.");
    const second = await runLeadTick({ ...base, noted: first.noted }, fake({ rows, watches: red }));
    expect(second.line).not.toContain("CI failed");
  });

  it("ignores a pull request from another branch", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building" })], watches: [watch({ headRef: "wp/2000-other" })], slot: { ok: false, reason: "full" } });
    await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("building");
  });
});

describe("lead tick step (d): ship on green", () => {
  const green = () => fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({})] });

  it("with Ship on green off, never merges: it reports the green pull request once", async () => {
    const ports = green();
    const result = await runLeadTick(base, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(result.line).toContain("#7 (WP-200) is green. Ship on green is off, so it waits for you.");
    const again = await runLeadTick({ ...base, noted: result.noted }, green());
    expect(again.line).not.toContain("is green");
  });

  it("with Ship on green on, a green pull request behind main still goes to the merge path: the merge gate judges its files (WP-202)", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ status: { behind: 4, mergeState: "BEHIND" } })] });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls).toContain("merge owner/app#7");
    expect(ports.rows[0].status).toBe("merged");
    expect(result.line).toContain("Merged WP-200");
  });

  it("with Ship on green on, sends a green pull request to the project's merge path", async () => {
    const ports = green();
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls).toContain("merge owner/app#7");
    expect(ports.rows[0].status).toBe("merged");
    expect(ports.outcomes).toEqual(["Merged WP-200: Build the thing (#7)."]);
    expect(result.line).toContain("Merged WP-200");
  });

  it("a merge that needs the person's word changes nothing and is said once", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open" })],
      watches: [watch({})],
      merge: { outcome: "needsYou", headSha: "abc1234", question: "owner/app#7 is green. Merge it?" },
    });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.rows[0].status).toBe("pr_open");
    expect(result.attention).toEqual(["#7 (WP-200) needs your word to merge: owner/app#7 is green. Merge it?"]);
  });

  it("never merges a security-parked package, even with Ship on green on", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open", securityPark: true })], watches: [watch({})] });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(result.attention[0]).toContain("is parked for a security check and is never merged by the tick");
  });

  it("never merges a package on the never-merge list", async () => {
    const ports = fake({ rows: [row({ id: "a", wp: "WP-92", status: "pr_open" })], watches: [watch({ title: "WP-92: keys" })] });
    await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("does not merge red, pending, draft or conflicting pull requests", async () => {
    for (const status of [{ passed: false, failed: ["x"] }, { passed: false, pending: 1 }, { draft: true }, { mergeable: "conflicting" as const }]) {
      const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ status })] });
      await runLeadTick({ ...base, shipOnGreen: true }, ports);
      expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
    }
  });
});

describe("lead tick step (e): a short activity line", () => {
  it("writes one line when the tick did something, and nothing for a quiet tick", async () => {
    const busy = fake({ rows: [row({ id: "a" })] });
    await runLeadTick(base, busy);
    expect(busy.notes).toHaveLength(1);
    expect(busy.notes[0]).toMatch(/^Lead tick: Started WP-200/);
    const quiet = fake({ rows: [row({ id: "a", status: "building" })], slot: { ok: false, reason: "full" } });
    await runLeadTick(base, quiet);
    expect(quiet.notes).toEqual([]);
  });

  it("has no en or em dashes in what a person reads", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ status: { passed: false, failed: ["t"] } })] });
    const result = await runLeadTick(base, ports);
    expect(`${result.line}${result.attention.join("")}`).not.toMatch(/[–—]/);
  });
});

describe("never-merge rule", () => {
  it("matches the WP-155 helper's rule", () => {
    const cases = [
      { title: "WP-92: keys", branch: "wp/92-keys", labels: [] },
      { title: "Fix", branch: "wp/150-phone", labels: [] },
      { title: "Fix", branch: "wp/158-x", labels: [] },
      { title: "Fix", branch: "wp/1580-x", labels: [] },
      { title: "Security park: auth", branch: "wp/9", labels: [] },
      { title: "Plain", branch: "wp/200-thing", labels: ["security-park"] },
      { title: "Plain", branch: "wp/200-thing", labels: [] },
      { title: "WP-920 is fine", branch: "b", labels: [] },
    ];
    for (const pr of cases) expect(neverMergeReason(pr) !== "", JSON.stringify(pr)).toBe(securityParkReason(pr, []) !== "");
  });

  it("reads the security-park label from the pull request", () => {
    expect(neverMergeReason({ title: "Plain", branch: "wp/200-thing", labels: ["security-park"] })).toBe("security-park label security-park");
  });

  it("has one never-merge list, shared by the tick and the WP-155 helper", () => {
    expect([...NEVER_MERGE_PACKAGES]).toEqual(neverMergeList.packages);
    expect([...HELPER_PACKAGES]).toEqual(neverMergeList.packages);
  });
});

describe("lead tick: a watch belongs to its package", () => {
  it("keeps a watch a Crew Deliver made, whose project is the folder path", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building" })], watches: [watch({ project: "/code/app", status: { pr: "merged" }, state: "ended", endReason: "merged" })] });
    await runLeadTick({ ...base, folder: "/code/app" }, ports);
    expect(ports.rows[0].status).toBe("merged");
  });

  it("ships a green Crew Deliver pull request to the merge path", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ project: "/code/app/" })] });
    await runLeadTick({ ...base, folder: "/code/app", shipOnGreen: true }, ports);
    expect(ports.calls).toContain("merge owner/app#7");
  });

  it("ignores a folder watch for a different project folder", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ project: "/code/other" })] });
    await runLeadTick({ ...base, folder: "/code/app", shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("ignores another project's pull request on the same branch", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open" })],
      watches: [watch({ project: "other", state: "ended", endReason: "merged", status: { pr: "merged" } })],
    });
    await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.rows[0].status).toBe("pr_open");
    expect(ports.calls.some((c) => c.startsWith("merge") || c === "status a merged")).toBe(false);
  });

  it("never merges another project's green pull request", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ project: "other" })] });
    await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("ignores a watch that ended before the package was claimed", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open", claimedAt: NOW - HOUR })],
      watches: [watch({ state: "ended", endedAt: NOW - 2 * HOUR, endReason: "merged", status: { pr: "merged" } })],
    });
    await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("pr_open");
  });

  it("reads a watch that ended after the package was claimed", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open", claimedAt: NOW - 2 * HOUR })],
      watches: [watch({ state: "ended", endedAt: NOW - HOUR, endReason: "merged", status: { pr: "merged" } })],
    });
    await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("merged");
  });
});

describe("lead tick: the merge is checked again on the row", () => {
  it("never merges a package that was parked while CI was being read", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({})] });
    ports.watches = async () => {
      ports.rows[0].securityPark = true;
      return [watch({})];
    };
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(result.attention[0]).toContain("is parked for a security check");
  });

  it("counts a merge GitHub says already happened as settled, not as a refusal", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open" })],
      watches: [watch({})],
      merge: { outcome: "refused", reason: "owner/app#7 is already merged." },
    });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.rows[0].status).toBe("merged");
    expect(result.attention).toEqual([]);
    expect(ports.outcomes).toEqual(["Merged WP-200: Build the thing (#7)."]);
  });

  it("does not read a refusal that only mentions 'already merged' as a settled merge", async () => {
    const question = "Is WP-12 already merged so this can rebase?";
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open" })],
      watches: [watch({})],
      merge: { outcome: "refused", reason: `A decision on this work is still open: ${question}. It merges once that is answered.` },
    });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.rows[0].status).toBe("pr_open");
    expect(ports.outcomes).toEqual([]);
    expect(result.attention).toEqual([`#7 (WP-200) was not merged: A decision on this work is still open: ${question}. It merges once that is answered.`]);
  });

  it("settles a package whose merge GitHub reports as already merged (its exact refusal, any case)", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "pr_open" })],
      watches: [watch({})],
      merge: { outcome: "refused", reason: "Owner/App#7 is already merged." },
    });
    await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.rows[0].status).toBe("merged");
  });

  it("never merges a package that left pr_open while CI was being read", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({})] });
    ports.watches = async () => {
      ports.rows[0].status = "failed";
      return [watch({})];
    };
    await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
  });

  it("never merges a pull request labelled security-park, even with Ship on green on", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "pr_open" })], watches: [watch({ status: { labels: ["security-park"] } })] });
    const result = await runLeadTick({ ...base, shipOnGreen: true }, ports);
    expect(ports.calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(result.attention[0]).toContain("is parked for a security check");
  });
});

describe("lead tick: a building package with no pull request", () => {
  it("stops holding its builder slot after six hours, and keeps its status", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building", claimedAt: NOW - 6 * HOUR - 1 })], slot: { ok: false, reason: "full" } });
    const result = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("building");
    expect(result.attention.join(" ")).toContain("WP-200 has no pull request after 6 hours, so it no longer holds a builder slot.");
  });

  it("does not settle a stale package while the watch list failed to read", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building", claimedAt: NOW - 7 * HOUR })], slot: { ok: false, reason: "full" }, watchesFail: true });
    const result = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("building");
    expect(result.attention).toEqual([]);
  });

  it("stops counting a stale package toward the slot, leaves its status, and says so once", async () => {
    const stale = row({ id: "a", status: "building", claimedAt: NOW - 7 * HOUR });
    const queued = row({ id: "b", wp: "WP-202", title: "Second", branch: "wp/202-second" });
    const ports = fake({ rows: [stale, queued], slot: { ok: false, reason: "full" } });
    const first = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("building");
    expect(ports.calls).toContain("slot 0");
    expect(first.attention).toHaveLength(1);
    expect(first.attention[0]).toContain("WP-200 has no pull request after 6 hours");
    const again = await runLeadTick({ ...base, noted: first.noted }, fake({ rows: [stale, queued], slot: { ok: false, reason: "full" } }));
    expect(again.attention).toEqual([]);
  });

  it("keeps a package that only just started", async () => {
    const ports = fake({ rows: [row({ id: "a", status: "building", claimedAt: NOW - 60_000 })], slot: { ok: false, reason: "full" } });
    await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("building");
  });
});

describe("lead tick: a closed pull request", () => {
  it("marks a building package failed when its pull request was closed unmerged, so its slot is free", async () => {
    const ports = fake({
      rows: [row({ id: "a", status: "building" })],
      watches: [watch({ state: "ended", endReason: "closed", status: { pr: "closed" } })],
      slot: { ok: false, reason: "full" },
    });
    const result = await runLeadTick(base, ports);
    expect(ports.rows[0].status).toBe("failed");
    expect(result.attention.join(" ")).toContain("#7 (WP-200) was closed without merging.");
  });
});

describe("lead tick: said-once keys", () => {
  it("keeps every key within the store's limit, however long the reason or the row id", async () => {
    const reason = "owner/app#7 is a draft; mark it ready first. ".repeat(40);
    const longId = "row-".repeat(120);
    const rows = [row({ id: longId, status: "pr_open" })];
    const first = await runLeadTick(
      { ...base, shipOnGreen: true },
      fake({ rows, watches: [watch({ status: { failed: [] } })], merge: { outcome: "refused", reason } }),
    );
    expect(first.attention).toHaveLength(1);
    expect(first.noted.length).toBeGreaterThan(0);
    for (const key of first.noted) expect(key.length).toBeLessThanOrEqual(NOTED_KEY_MAX);
    const second = await runLeadTick(
      { ...base, shipOnGreen: true, noted: first.noted },
      fake({ rows, watches: [watch({})], merge: { outcome: "refused", reason } }),
    );
    expect(second.attention).toEqual([]);
  });
});
