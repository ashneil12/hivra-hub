import { afterEach, describe, expect, it, vi } from "vitest";

// This app's own look for each tool on disk: here every tool is found.
vi.mock("./child", () => {
  const found = async () => "/usr/local/bin/example";
  return {
    resolveAntigravityBinary: found,
    resolveClaudeBinary: found,
    resolveCodexBinary: found,
    resolveCursorBinary: found,
    resolveDevinBinary: found,
    resolveFxBinary: found,
    resolveGrokBinary: found,
    resolveHermesBinary: found,
    resolveOmpBinary: found,
    resolveOpenCodeBinary: found,
    resolvePiBinary: found,
  };
});
vi.mock("./registry", () => ({ isLiveHarness: () => true }));

import { harnessUnavailableHint, isHarnessAvailable, probeHarnessAvailability, setHarnessAvailabilitySource, type HarnessAvailability } from "./availability";
import { HARNESSES } from "../../../features/sessions/model/session";
import { engineSaysWhichToolsRun, harnessEngineFacts, resetHarnessAvailabilityForTests } from "./availabilityState";

const all = (value: boolean) => Object.fromEntries(HARNESSES.map((id) => [id, value])) as HarnessAvailability;

describe("which coding tools can run, when an engine starts them", () => {
  afterEach(() => {
    setHarnessAvailabilitySource(null);
    resetHarnessAvailabilityForTests();
  });

  it("is what the engine says, with its reason for a tool it cannot run", async () => {
    setHarnessAvailabilitySource(async () => ({
      available: { ...all(true), hermes: false },
      why: { hermes: "The engine has no provider set up for Hermes." },
      facts: { claude: { version: "2.1.50", signedIn: true } },
    }));
    await probeHarnessAvailability({ force: true });
    expect(harnessEngineFacts("claude")).toEqual({ version: "2.1.50", signedIn: true });
    expect(harnessEngineFacts("hermes")).toBeUndefined();
    expect(engineSaysWhichToolsRun()).toBe(true);
    expect(isHarnessAvailable("claude")).toBe(true);
    expect(isHarnessAvailable("hermes")).toBe(false);
    expect(harnessUnavailableHint("hermes")).toBe("The engine has no provider set up for Hermes.");
  });

  it("falls back to this app's own look when the engine does not say or cannot be reached", async () => {
    for (const source of [async () => undefined, async () => Promise.reject(new Error("engine is down"))]) {
      setHarnessAvailabilitySource(source);
      await probeHarnessAvailability({ force: true });
      expect(isHarnessAvailable("hermes")).toBe(true);
      expect(harnessUnavailableHint("hermes")).toContain("Hermes Agent CLI not found");
      expect(harnessEngineFacts("claude")).toBeUndefined();
      expect(engineSaysWhichToolsRun()).toBe(false);
    }
  });
});
