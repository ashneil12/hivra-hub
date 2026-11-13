// @vitest-environment happy-dom
// SC-3b: who may run the ship check from a chat (`ship_check.run`, the `ship_check` tool), that it runs in the chat's own
// project, and that what a first mate gets back is what it may report: the outcome and what was and was not tested.
import { describe, expect, it, vi } from "vitest";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import type { ShipCheckRecord } from "../../hub/model/shipCheck";
import { newSession, type Session } from "../../sessions/model/session";
import { appActions, handleAgentApp, type AgentAppHost } from "./agentApp";
import { handleShipCheck } from "./agentAppShipCheck";

vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function record(over: Partial<ShipCheckRecord> = {}): ShipCheckRecord {
  return {
    project: "/code/hivra",
    head: HEAD,
    base: null,
    commitsCovered: 12,
    at: 1_700_000_000_000,
    outcome: "passed",
    note: "First ship check: covered the last 30 commits",
    steps: [
      {
        name: "Project checks",
        outcome: "passed",
        detail: "ran and passed",
        command: "npm run check",
        outputTail: "412 passed",
      },
    ],
    tested: ["Web checks: 412 tests passed."],
    notTested: ["Review: no task briefs landed in this range."],
    ...over,
  };
}

type Who = "mono" | "team" | "worker" | "habit" | "habit-mono" | "checker" | "mono-two";

function fixture(who: Who, run = vi.fn(async (_cwd: string): Promise<unknown> => record())) {
  const source: Session = {
    // A Mono with two projects works from a folder of its own, so it has to name the project it means.
    ...newSession("claude", who === "mono-two" ? "/code/mono-home" : "/code/hivra", "claude:opus-5-5"),
    id: who === "worker" ? "app-w1" : `chat-${who}`,
  };
  const projects = who === "mono-two" ? ["/code/hivra", "/code/other"] : ["/code/hivra"];
  const host = {
    // A Mono's habit run is a Mono session too (`habit-mono`): it is still not the Mono's own chat.
    isMono: () => who === "mono" || who === "mono-two" || who === "checker" || who === "habit-mono",
    isHabitRun: () => who === "habit" || who === "habit-mono",
    monoOf: () =>
      who === "mono" || who === "mono-two" || who === "habit" || who === "habit-mono" || who === "checker"
        ? { id: who === "checker" ? CHECKER_MONO_ID : "hivra-lead", name: "Hivra lead", projects }
        : undefined,
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    shipCheck: { run },
  } as unknown as AgentAppHost;
  return { source, host, run };
}

describe("ship_check.run", () => {
  it("is an app action a first mate can call", () => {
    expect(appActions()).toContain("ship_check.run");
  });

  it("runs for a Mono's chat in its own project and answers with what was and wasn't tested", async () => {
    const { source, host, run } = fixture("mono");
    const answer = await handleAgentApp(source, "r1", "ship_check.run", {}, host);
    expect(run).toHaveBeenCalledWith("/code/hivra");
    expect(answer).toEqual({
      outcome: "passed",
      head: HEAD,
      version: "0123456",
      commitsCovered: 12,
      note: "First ship check: covered the last 30 commits",
      tested: ["Web checks: 412 tests passed."],
      notTested: ["Review: no task briefs landed in this range."],
      // A step's command and output stay in the app's own record, not in the tool's answer.
      steps: [{ name: "Project checks", outcome: "passed", detail: "ran and passed" }],
    });
  });

  it("runs for a coding-team chat in the team's project", async () => {
    const { source, host, run } = fixture("team");
    await handleAgentApp(source, "r1", "ship_check.run", {}, host);
    expect(run).toHaveBeenCalledWith("/code/hivra");
  });

  it("reports a check that could not run as one that could not run", async () => {
    const { source, host } = fixture(
      "mono",
      vi.fn(async () =>
        record({
          outcome: "couldNotRun",
          steps: [{ name: "Review", outcome: "couldNotRun", detail: "the model gave no answer" }],
          tested: [],
          notTested: ["Review: the model gave no answer."],
        }),
      ),
    );
    const answer = (await handleAgentApp(source, "r1", "ship_check.run", {}, host)) as { outcome: string };
    expect(answer.outcome).toBe("couldNotRun");
  });

  it("makes a Mono with two projects name one, and runs in the one it names", async () => {
    const { source, host, run } = fixture("mono-two");
    await expect(handleAgentApp(source, "r1", "ship_check.run", {}, host)).rejects.toThrow(/Pass "project"/);
    expect(run).not.toHaveBeenCalled();
    await handleAgentApp(source, "r2", "ship_check.run", { project: "/code/other" }, host);
    expect(run).toHaveBeenCalledWith("/code/other");
    await expect(handleAgentApp(source, "r3", "ship_check.run", { project: "/code/elsewhere" }, host)).rejects.toThrow(
      /Not one of your projects/,
    );
  });

  it("refuses a worker, a habit run and the checker, and runs nothing for them", async () => {
    const worker = fixture("worker");
    await expect(handleAgentApp(worker.source, "r1", "ship_check.run", {}, worker.host)).rejects.toThrow(
      /Only a first mate's own chat/,
    );
    const habit = fixture("habit");
    await expect(handleAgentApp(habit.source, "r1", "ship_check.run", {}, habit.host)).rejects.toThrow(
      /habit run doesn't run the ship check/,
    );
    const checker = fixture("checker");
    await expect(handleAgentApp(checker.source, "r1", "ship_check.run", {}, checker.host)).rejects.toThrow(/checker only reads/);
    for (const who of [worker, habit, checker]) expect(who.run).not.toHaveBeenCalled();
  });

  it("refuses a Mono's habit run even though its session is a Mono's, with a plain reason", async () => {
    const habit = fixture("habit-mono");
    await expect(handleAgentApp(habit.source, "r1", "ship_check.run", {}, habit.host)).rejects.toThrow(
      "A habit run doesn't run the ship check. The first mate does, from its own chat.",
    );
    expect(habit.run).not.toHaveBeenCalled();
  });

  it("refuses a field it doesn't know before it runs anything", async () => {
    const { source, host, run } = fixture("mono");
    await expect(
      handleAgentApp(source, "r1", "ship_check.run", { path: "/etc", paths: ["src"] }, host),
    ).rejects.toThrow(/Unknown ship_check.run fields: path, paths/);
    expect(run).not.toHaveBeenCalled();
  });

  it("gives a coding-team chat no project to name", async () => {
    const { source, host, run } = fixture("team");
    await expect(handleAgentApp(source, "r1", "ship_check.run", { project: "/code/other" }, host)).rejects.toThrow(
      /project is only for a Mono/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("says why when the app could not run it, in the app's own words", async () => {
    const { source, host } = fixture(
      "mono",
      vi.fn(async () => {
        throw "Another ship check is already running for this project.";
      }),
    );
    await expect(handleAgentApp(source, "r1", "ship_check.run", {}, host)).rejects.toThrow(
      "Another ship check is already running for this project.",
    );
  });

  it("refuses an answer that isn't a record instead of reporting a result", async () => {
    const { source, host } = fixture("mono", vi.fn(async () => ({ outcome: "passed", tested: ["everything"] })));
    await expect(handleAgentApp(source, "r1", "ship_check.run", {}, host)).rejects.toThrow(/couldn't be read/);
  });

  // ---- PT-4: the proof tools a ship check puts forward ---------------------------------------------------------------------

  describe("the proof tools it puts forward", () => {
    function claimFor(toolId: string, claimed = true, status = "proposed") {
      return {
        claimed,
        status: claimed ? "proposed" : status,
        revision: 4,
        key: `proof-tools/${toolId}/0123456789ab`,
        question: `Add ${toolId} to this project?`,
        options: ["Add it", "Not now"],
        recommended: "Add it",
        tool: { install: `npm install --save-dev ${toolId}` },
        note: claimed ? "Not proposed before for this project. File the question now." : "Already proposed.",
      };
    }

    function withBackend(proposals: { toolId: string; name: string }[], claims: Record<string, ReturnType<typeof claimFor>>) {
      const run = vi.fn(async (_cwd: string): Promise<unknown> => ({ ...record(), proposals }));
      const base = fixture("mono", run);
      const claim = vi.fn(async (_folder: string, toolId: string) => claims[toolId]);
      const release = vi.fn(async () => true);
      const host = { ...base.host, proofTools: { list: vi.fn(), claim, release } } as unknown as AgentAppHost;
      return { ...base, host, claim, release };
    }

    const call = (f: { source: Session; host: AgentAppHost }, ask?: (input: Record<string, unknown>) => Promise<unknown>) =>
      handleShipCheck(f.source, "ship_check.run", {}, f.host, () => "/code/hivra", ask);

    it("files each one through the claim and the ask, in the order the app gave, and tells the first mate to say so", async () => {
      const f = withBackend(
        [
          { toolId: "e2e", name: "e2e" },
          { toolId: "playwright", name: "Playwright" },
        ],
        { e2e: claimFor("e2e"), playwright: claimFor("playwright") },
      );
      const ask = vi.fn(async (_input: Record<string, unknown>) => ({ state: "open" }));
      const answer = await call(f, ask);
      expect(f.claim.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ["/code/hivra", "e2e"],
        ["/code/hivra", "playwright"],
      ]);
      expect(ask.mock.calls.map((c) => c[0].key)).toEqual([
        "proof-tools/e2e/0123456789ab",
        "proof-tools/playwright/0123456789ab",
      ]);
      expect(ask.mock.calls[0][0]).toMatchObject({ options: ["Add it", "Not now"], recommended: "Add it" });
      expect(answer.proposals).toHaveLength(2);
      expect(answer.proposals?.[0]).toMatchObject({ proposed: true, toolId: "e2e", install: "npm install --save-dev e2e" });
      expect(answer.proposalsNote).toContain("The app installs nothing");
      // Adding anything still needs the person's tap: nothing was released, nothing was installed here.
      expect(f.release).not.toHaveBeenCalled();
    });

    it("asks nothing for a tool already proposed or declined, so a Not now is never asked again", async () => {
      const f = withBackend(
        [
          { toolId: "stryker", name: "StrykerJS" },
          { toolId: "fast-check", name: "fast-check" },
        ],
        { stryker: claimFor("stryker", false, "declined"), "fast-check": claimFor("fast-check") },
      );
      const ask = vi.fn(async (_input: Record<string, unknown>) => ({ state: "open" }));
      const answer = await call(f, ask);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][0].key).toBe("proof-tools/fast-check/0123456789ab");
      expect(answer.proposals?.[0]).toMatchObject({ proposed: false, toolId: "stryker", status: "declined" });
      expect(answer.proposals?.[1]).toMatchObject({ proposed: true, toolId: "fast-check" });
    });

    it("gives a claim back when the question could not be filed, says so, and still files the others", async () => {
      const f = withBackend(
        [
          { toolId: "e2e", name: "e2e" },
          { toolId: "playwright", name: "Playwright" },
        ],
        { e2e: claimFor("e2e"), playwright: claimFor("playwright") },
      );
      const ask = vi
        .fn(async (_input: Record<string, unknown>) => ({ state: "open" }))
        .mockRejectedValueOnce(new Error("The decision store timed out."));
      const answer = await call(f, ask);
      // A timeout is not a final no: the claim is undone so the next ship check may put it forward again.
      expect(f.release).toHaveBeenCalledWith("/code/hivra", "e2e", 4);
      expect(answer.proposals?.[0]).toMatchObject({ proposed: false, toolId: "e2e" });
      expect(String(answer.proposals?.[0].note)).toContain("The next ship check will put it forward again.");
      expect(answer.proposals?.[1]).toMatchObject({ proposed: true, toolId: "playwright" });
      expect(answer.outcome).toBe("passed");
    });

    it("claims and files nothing without an ask path, and says nothing of proposals when there are none", async () => {
      const f = withBackend([{ toolId: "e2e", name: "e2e" }], { e2e: claimFor("e2e") });
      const plain = await call(f);
      expect(f.claim).not.toHaveBeenCalled();
      expect(plain.proposals).toBeUndefined();
      const none = withBackend([], {});
      const ask = vi.fn();
      const answer = await call(none, ask);
      expect(ask).not.toHaveBeenCalled();
      expect("proposals" in answer).toBe(false);
      expect("proposalsNote" in answer).toBe(false);
    });
  });

  it("starts one run when two asks arrive for the same project together", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const run = vi.fn((_cwd: string) => new Promise<unknown>((resolve) => (finish = resolve)));
    const a = fixture("mono", run);
    const b = fixture("team", run);
    const first = handleAgentApp(a.source, "r1", "ship_check.run", {}, a.host);
    const second = handleAgentApp(b.source, "r2", "ship_check.run", {}, b.host);
    // Let both reach the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);
    finish(record());
    const [x, y] = await Promise.all([first, second]);
    expect(x).toEqual(y);
  });
});
