import { describe, expect, it } from "vitest";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { monoState } from "./mono";
import { lastTurnFailure, plainFailure, resetClock } from "./turnFailure";

const NOW = new Date(2026, 9, 20, 18, 0).getTime();

/** A Mono chat whose turn ran into what Claude Code reports for a refused request (the realtest's recorded fixtures). */
function failed(event: { message: string; errorClass?: "billing" | "overloaded" | "usage_limit" | "auth" | "provider_error"; retryable?: boolean; resetsAt?: number }, cliLine?: string): Session {
  let session: Session = {
    ...newSession("claude", "/p/tally"),
    busy: true,
    blocks: [{ id: "u", role: "user", text: "status? one line" }],
  };
  if (cliLine) session = { ...session, blocks: [...session.blocks, { id: "a", role: "assistant", text: cliLine }] };
  session = applyHarnessEvent(session, { type: "session.error", ...event });
  return { ...session, busy: false };
}

describe("a failed turn is a state of its own", () => {
  const out402 = () =>
    failed(
      { message: "Billing refused (402): openrouter.ai said: Insufficient credits", errorClass: "billing", retryable: false },
      "API Error: 402 openrouter.ai said: Insufficient credits",
    );

  it("reproduces the baseline: before, a 402 left the Mono idle with only raw text in its chat", () => {
    // What the app keeps from the event: the error notice now carries why it failed.
    const notice = out402().blocks.at(-1)!;
    expect(notice).toMatchObject({ role: "system", notice: "error", failure: { errorClass: "billing", retryable: false } });
  });

  it("a 402 reads Out of credits, red, with the provider's words behind details", () => {
    const failure = lastTurnFailure(out402(), NOW);
    expect(failure).toMatchObject({
      reason: "Out of credits",
      tone: "red",
      errorClass: "billing",
      retryable: false,
      detail: "Billing refused (402): openrouter.ai said: Insufficient credits",
    });
    expect(monoState(out402())).toEqual({
      status: "failed",
      activity: "Out of credits",
      tone: "red",
      detail: "Billing refused (402): openrouter.ai said: Insufficient credits",
    });
  });

  it("survives a restart: the cause is saved with the notice", () => {
    const saved = JSON.parse(JSON.stringify(sanitizeSessionForPersist(out402()))) as Session;
    expect(saved.blocks.at(-1)?.failure).toMatchObject({ errorClass: "billing", retryable: false });
    expect(lastTurnFailure(saved, NOW)?.reason).toBe("Out of credits");
  });

  it("a 529 reads overloaded, amber: Try again can work", () => {
    const session = failed({ message: "API overloaded (529): Overloaded", errorClass: "overloaded", retryable: true });
    expect(lastTurnFailure(session, NOW)).toMatchObject({ reason: "The model is overloaded", tone: "amber", retryable: true });
  });

  it("a usage limit says until when, in the Mac's own time", () => {
    const resetsAt = new Date(2026, 9, 20, 23, 0).getTime();
    const session = { ...failed({ message: "Usage limit reached: You've hit your limit", errorClass: "usage_limit", retryable: true, resetsAt }), usageLimit: { resetsAt } };
    expect(lastTurnFailure(session, NOW)?.reason).toBe("Out of usage until 23:00");
    // Stopped at a limit with no notice in this chat (a refused window): the same state.
    expect(lastTurnFailure({ blocks: [], busy: false, usageLimit: { resetsAt } }, NOW)).toMatchObject({ reason: "Out of usage until 23:00", tone: "amber", blockId: "usage-limit" });
  });

  it("plain reasons for each kind, and a clock with its day when the reset is more than a day off", () => {
    expect(plainFailure({ errorClass: "auth" }, "OAuth token has expired. Please run /login", NOW)).toEqual({ reason: "Signed out of the model", tone: "red" });
    expect(plainFailure({ errorClass: "billing" }, "account on hold", NOW)).toEqual({ reason: "Billing refused", tone: "red" });
    expect(plainFailure({ errorClass: "provider_error", retryable: true }, "Connection error.", NOW).reason).toBe("Lost the connection to the model");
    expect(plainFailure({ errorClass: "provider_error", retryable: false }, "400 bad request", NOW)).toEqual({ reason: "The model refused the request", tone: "red" });
    expect(plainFailure({}, "Claude exited", NOW)).toEqual({ reason: "Its last turn failed", tone: "amber" });
    expect(resetClock(new Date(2026, 9, 22, 5, 0).getTime(), NOW)).toMatch(/^[A-Z][a-z]{2} 05:00$/);
  });

  it("clears once anything happens after it: a new turn, a reply, a running turn", () => {
    const session = out402();
    expect(lastTurnFailure({ ...session, busy: true }, NOW)).toBeUndefined();
    const replied: Block[] = [...session.blocks, { id: "u2", role: "user", text: "try again" }, { id: "a2", role: "assistant", text: "All green." }];
    expect(lastTurnFailure({ ...session, blocks: replied }, NOW)).toBeUndefined();
    expect(monoState({ ...session, blocks: replied })).toEqual({ status: "idle" });
    // Status lines after the error are not anything happening.
    const status: Block[] = [...session.blocks, { id: "s", role: "system", text: "API retry 1 of 10" }];
    expect(lastTurnFailure({ ...session, blocks: status }, NOW)?.reason).toBe("Out of credits");
    expect(lastTurnFailure({ ...session, worktreeRemoved: true }, NOW)).toBeUndefined();
  });
});
