import { describe, expect, it } from "vitest";
import { readAppIdentity } from "./appIdentity";
import { claimVerifyKickoff, pendingVerifyKickoff } from "./verifyKickoff";

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
});
