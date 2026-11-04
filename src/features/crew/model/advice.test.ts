import { expect, it } from "vitest";
import type { MonoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { withCrewAdvice } from "./advice";

function failed(reason?: string): MonoSessionCompletionResult {
  return {
    sessionId: "child-1",
    project: "/tmp/vg-game",
    title: "Build it",
    originalPrompt: "Build it",
    result: "",
    truncated: false,
    status: "failed",
    ...(reason ? { reason } : {}),
  };
}

it("names the next signed-in CLI on a reroute, and starts nothing", () => {
  const told = withCrewAdvice(failed("failed: auth refused"), { action: "reroute", to: "codex" });
  expect(told.reason).toBe("failed: auth refused. Codex is signed in and can take this.");
  expect(told).not.toHaveProperty("launched");
});

it("does not add a second stop when the reason already ends", () => {
  const told = withCrewAdvice(failed("failed: auth refused."), { action: "reroute", to: "claude" });
  expect(told.reason).toBe("failed: auth refused. Claude Code is signed in and can take this.");
});

it("leaves the reason alone when nothing should move", () => {
  const reason = "failed: the work failed";
  expect(withCrewAdvice(failed(reason), { action: "first-mate" })).toMatchObject({ reason });
  expect(withCrewAdvice(failed(reason), { action: "reroute" })).toMatchObject({ reason });
  expect(withCrewAdvice(failed(reason), { action: "reroute", to: "not-a-cli" })).toMatchObject({ reason });
  expect(withCrewAdvice(failed(reason), undefined)).toMatchObject({ reason });
  expect(withCrewAdvice(failed(), { action: "reroute", to: "codex" }).reason).toBe(
    "Codex is signed in and can take this.",
  );
});
