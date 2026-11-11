import { describe, expect, it } from "vitest";
import { automationRunErrorClass } from "./runFailure";

const CLAUDE_MISSING =
  "Claude Code CLI not found. Install it from https://claude.com/product/claude-code and run `claude auth login`, then retry.";

describe("automationRunErrorClass", () => {
  it("classes a missing CLI as missing_cli and leaves other classes alone", () => {
    expect(
      automationRunErrorClass({ message: "command not found", harness: "codex" }),
    ).toBe("missing_cli");
    expect(
      automationRunErrorClass({ message: CLAUDE_MISSING, harness: "claude" }),
    ).toBe("missing_cli");
    expect(
      automationRunErrorClass({
        message: "no such file or directory: hermes",
        harness: "hermes",
      }),
    ).toBe("missing_cli");
    expect(
      automationRunErrorClass({
        message: "cannot find package @cursor/sdk",
        harness: "cursor",
      }),
    ).toBe("sdk_not_installed");

    expect(
      automationRunErrorClass({
        message: "the model is overloaded",
        providerClass: "overloaded",
        harness: "claude",
      }),
    ).toBe("overloaded");
    expect(
      automationRunErrorClass({
        message: "boom",
        providerClass: "provider_error",
        harness: "claude",
      }),
    ).toBe("provider_error");
    expect(
      automationRunErrorClass({
        message: "quota exceeded",
        providerClass: "overloaded",
        harness: "claude",
      }),
    ).toBe("overloaded");
    expect(
      automationRunErrorClass({
        message: "card declined",
        providerClass: "billing",
        harness: "claude",
      }),
    ).toBe("billing");
    expect(
      automationRunErrorClass({ message: "disk full", harness: "codex" }),
    ).toBeUndefined();
  });
});
