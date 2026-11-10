import { describe, expect, it } from "vitest";
import type { HarnessId } from "../../../features/sessions/model/session";
import { harnessCannotSteer, registerHarness, type HarnessAdapter } from "./registry";

function stub(id: HarnessId, canSteer?: boolean, live = true): HarnessAdapter {
  return {
    id,
    live,
    ...(canSteer === undefined ? {} : { canSteer }),
    async sendTurn() {},
    async steerTurn() {},
    async cancelTurn() {},
    respondApproval() {},
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
  };
}

describe("harnessCannotSteer", () => {
  it("is false when that agent has no adapter", () => {
    expect(harnessCannotSteer("hermes")).toBe(false);
    expect(harnessCannotSteer("omp")).toBe(false);
  });

  it("is true only for a live adapter that refuses to steer", () => {
    registerHarness(stub("grok", false));
    registerHarness(stub("fx", false));
    registerHarness(stub("devin", false));
    registerHarness(stub("antigravity", false));
    registerHarness(stub("claude"));
    registerHarness(stub("codex", true));
    registerHarness(stub("cursor"));
    registerHarness(stub("opencode"));
    registerHarness(stub("pi"));
    expect(harnessCannotSteer("grok")).toBe(true);
    expect(harnessCannotSteer("fx")).toBe(true);
    expect(harnessCannotSteer("devin")).toBe(true);
    expect(harnessCannotSteer("antigravity")).toBe(true);
    expect(harnessCannotSteer("claude")).toBe(false);
    expect(harnessCannotSteer("codex")).toBe(false);
    expect(harnessCannotSteer("cursor")).toBe(false);
    expect(harnessCannotSteer("opencode")).toBe(false);
    expect(harnessCannotSteer("pi")).toBe(false);
  });

  it("does not treat a stopped adapter as a refusal", () => {
    registerHarness(stub("fx", false, false));
    expect(harnessCannotSteer("fx")).toBe(false);
  });
});
