import { describe, expect, it } from "vitest";
import type { ControlOutcome } from "../../features/orchestration/model/orchestration";
import { providerFailureOf, withProviderFailure } from "./turnFailure";

/** What a monitored turn's outcome keeps from the provider's failure reports. */

const pending: ControlOutcome = {
  status: "failed",
  text: "",
  error: "Turn did not complete",
};

describe("a monitored turn's provider failure", () => {
  it("takes the error, its class, retryability and reset from the report", () => {
    const outcome = withProviderFailure(pending, {
      type: "session.error",
      message: "Usage limit reached: You've hit your limit",
      errorClass: "usage_limit",
      retryable: true,
      resetsAt: 1_790_000_000_000,
    });
    expect(providerFailureOf(outcome)).toEqual({
      error: "Usage limit reached: You've hit your limit",
      errorClass: "usage_limit",
      retryable: true,
      resetsAt: 1_790_000_000_000,
    });
  });

  it("lets a later unclassified error replace an earlier class", () => {
    const billing = withProviderFailure(pending, {
      type: "session.error",
      message: "Billing refused (402): Insufficient credits",
      errorClass: "billing",
      retryable: false,
    });
    const exited = withProviderFailure(billing, {
      type: "session.error",
      message: "Claude Code exited",
    });
    expect(providerFailureOf(exited)).toEqual({ error: "Claude Code exited" });
  });

  it("reports only the error when the provider gave no class", () => {
    expect(providerFailureOf({ ...pending, error: "Harness is not connected" })).toEqual({
      error: "Harness is not connected",
    });
    expect(providerFailureOf({ status: "failed", text: "" })).toEqual({});
  });
});
