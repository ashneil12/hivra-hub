import { describe, expect, it, vi } from "vitest";
import { readAppIdentity } from "./appIdentity";
import {
  claimVerifyKickoff,
  claimVerifyMessage,
  pendingVerifyKickoff,
  unsentVerifyMessages,
  verifyKickoffMono,
  verifyRun,
  watchVerifyMessages,
} from "./verifyKickoff";

const base = {
  product: "MonoCode Hub",
  version: "0.16.0",
  stamp: { sha: "abc1234", branch: "hub/1b-resume", dirty: false, builtAt: "" },
  policy: {},
};
const kickoff = { project: "/tmp/verify/repo", monoName: "Verify Lead", prompt: "VERIFY-LEAD-KICKOFF" };

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("the fake-Claude test bench's kickoff", () => {
  it("goes out once per run, from a dev copy's plan only", () => {
    const dev = readAppIdentity({
      ...base,
      kind: "dev",
      identifier: "com.ash.monocode-hub.dev.verify",
      slot: "verify",
      verify: { runId: "run-1", kickoff },
    });
    const storage = memory();
    expect(pendingVerifyKickoff(dev, storage)).toEqual({ ...kickoff, runId: "run-1" });
    claimVerifyKickoff("run-1", storage);
    expect(pendingVerifyKickoff(dev, storage)).toBeNull();
    // A new run kicks off again.
    const next = readAppIdentity({
      ...base,
      kind: "dev",
      identifier: "com.ash.monocode-hub.dev.verify",
      verify: { runId: "run-2", kickoff },
    });
    expect(pendingVerifyKickoff(next, storage)?.runId).toBe("run-2");
  });

  it("is never read from the daily app's identity", () => {
    const daily = readAppIdentity({
      ...base,
      kind: "daily",
      identifier: "com.ash.monocode-hub",
      verify: { runId: "run-1", kickoff },
    });
    expect(daily?.verify).toBeUndefined();
    expect(pendingVerifyKickoff(daily, memory())).toBeNull();
    expect(pendingVerifyKickoff(null, memory())).toBeNull();
  });

  it("carries an existing Mono's id through, and waits until that Mono works on the project", async () => {
    const team = { ...kickoff, monoName: "Chief of Staff", monoId: "chief-of-staff" };
    const dev = readAppIdentity({
      ...base,
      kind: "dev",
      identifier: "com.ash.monocode-hub.dev.verify",
      verify: { runId: "run-3", kickoff: team },
    });
    expect(pendingVerifyKickoff(dev, memory())?.monoId).toBe("chief-of-staff");

    let clock = 0;
    let tiedAt = 2_000;
    const created: string[] = [];
    const host = {
      create: (project: string, name: string) => (created.push(`${name}@${project}`), "new-mono"),
      ready: (id: string, project: string) => id === "chief-of-staff" && project === kickoff.project && clock >= tiedAt,
      sleep: async (ms: number) => void (clock += ms),
      now: () => clock,
    };
    expect(await verifyKickoffMono(team, host)).toBe("chief-of-staff");
    expect(clock).toBe(2_000);
    tiedAt = Infinity;
    clock = 0;
    expect(await verifyKickoffMono(team, host, 5_000)).toBeNull();
    expect(created).toEqual([]);
    // Without monoId: a new Mono on the project, with the plan's name.
    expect(await verifyKickoffMono(kickoff, host)).toBe("new-mono");
    expect(created).toEqual(["Verify Lead@/tmp/verify/repo"]);
  });
});

describe("Ash's messages the bench sends mid-run", () => {
  const listed = {
    messages: [
      { id: "flow-ash-1", monoId: "verify-lead", prompt: "VERIFY-FLOW-ASH-1 how is it going?" },
      { id: "bad id!", monoId: "verify-lead", prompt: "ignored" },
      { id: "flow-ash-2", monoId: "", prompt: "no Mono" },
      { id: "flow-ash-3", monoId: "verify-lead", prompt: "VERIFY-FLOW-ASH-3" },
    ],
  };

  it("are sent by a dev copy with a plan only, each once per run (a restart of the run never sends one again)", () => {
    const dev = readAppIdentity({ ...base, kind: "dev", identifier: "com.ash.monocode-hub.dev.verify", verify: { runId: "run-9" } });
    const daily = readAppIdentity({ ...base, kind: "daily", identifier: "com.ash.monocode-hub", verify: { runId: "run-9" } });
    expect(verifyRun(dev)).toBe("run-9");
    expect(verifyRun(daily)).toBeNull();
    const storage = memory();
    expect(unsentVerifyMessages("run-9", listed, storage).map((m) => m.id)).toEqual(["flow-ash-1", "flow-ash-3"]);
    claimVerifyMessage("run-9", "flow-ash-1", storage);
    expect(unsentVerifyMessages("run-9", listed, storage).map((m) => m.id)).toEqual(["flow-ash-3"]);
    // Another run starts over; junk answers send nothing.
    expect(unsentVerifyMessages("run-10", listed, storage).map((m) => m.id)).toEqual(["flow-ash-1", "flow-ash-3"]);
    expect(unsentVerifyMessages("run-9", null, storage)).toEqual([]);
    expect(unsentVerifyMessages("run-9", { messages: "x" }, storage)).toEqual([]);
  });

  it("are looked for every second and sent in order, one pass at a time", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const stop = watchVerifyMessages("run-11", {
        list: async () => listed,
        send: async (message) => void sent.push(message.id),
        everyMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual(["flow-ash-1", "flow-ash-3"]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
