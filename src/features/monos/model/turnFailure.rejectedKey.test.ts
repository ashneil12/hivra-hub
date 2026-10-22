// A rejected API key is Ash's to fix (Settings), so it is red Needs you, even when the provider sent no error kind or a
// generic one (PM 22 Oct: a DeepSeek / custom model key refused with a bare 401 showed as grey "Can't answer").
import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { failureChip } from "../../hub/model/statusChip";
import { newSession, type Session } from "../../sessions/model/session";
import { failureClass, lastTurnFailure } from "./turnFailure";

const NOW = new Date(2026, 9, 22, 13, 0).getTime();

function failed(event: { message: string; errorClass?: "auth" | "provider_error" | "overloaded"; retryable?: boolean }): Session {
  let session: Session = { ...newSession("claude", "/p/hub"), busy: true, blocks: [{ id: "u", role: "user", text: "status?" }] };
  session = applyHarnessEvent(session, { type: "session.error", ...event });
  return { ...session, busy: false };
}

describe("a rejected key reads as a sign-in error", () => {
  const REJECTED = [
    "HTTP 401: Authentication Fails, Your api key: ****abcd is invalid",
    "403 Forbidden",
    "Error: invalid key",
    "invalid_api_key: Incorrect API key provided",
    "Unauthorized",
    "authentication failed for this request",
  ];

  for (const message of REJECTED) {
    for (const errorClass of [undefined, "provider_error"] as const) {
      it(`${JSON.stringify(message)} with ${errorClass ?? "no error kind"} is red Needs you`, () => {
        const f = lastTurnFailure(failed({ message, ...(errorClass ? { errorClass } : {}) }), NOW)!;
        expect(f.errorClass).toBe("auth");
        expect(f.tone).toBe("red");
        expect(f.retryable).toBe(false);
        expect(f.reason).toMatch(/Sign-in refused|Signed out of the model/);
        expect(failureChip(f.tone)).toEqual({ word: "Needs you", tone: "red" });
      });
    }
  }

  it("leaves other failures as they were (grey Can't answer when they come right by themselves)", () => {
    for (const [message, errorClass] of [
      ["The model is overloaded (529)", "overloaded"],
      ["Connection to the API was lost", "provider_error"],
      ["HTTP 524: upstream timed out", "provider_error"],
      ["server error", undefined],
    ] as const) {
      const f = lastTurnFailure(failed({ message, ...(errorClass ? { errorClass } : {}) }), NOW)!;
      expect(f.errorClass).toBe(errorClass);
      expect(failureChip(f.tone)).toEqual({ word: "Can't answer", tone: "grey" });
    }
    expect(failureClass("billing", "401 payment")).toBe("billing");
    expect(failureClass("usage_limit", "unauthorized")).toBe("usage_limit");
  });
});
