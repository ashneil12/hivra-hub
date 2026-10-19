import { describe, expect, it } from "vitest";
import { newSession, type Session } from "../../../features/sessions/model/session";
import { applyHarnessEvent } from "./apply";
import {
  failedReason,
  isProviderErrorClass,
  providerRetryText,
} from "./providerFailure";
import type { HarnessEvent } from "./types";

function chat(): Session {
  return {
    ...newSession("claude", "/repo"),
    blocks: [{ id: "u1", role: "user", text: "do the work" }],
  };
}

function apply(session: Session, ...events: HarnessEvent[]): Session {
  return events.reduce(applyHarnessEvent, session);
}

const retry = (
  attempt: number,
  extra: Partial<Extract<HarnessEvent, { type: "provider.retry" }>> = {},
): HarnessEvent => ({
  type: "provider.retry",
  attempt,
  maxAttempts: 10,
  errorStatus: 529,
  errorClass: "overloaded",
  ...extra,
});

describe("provider failure wording", () => {
  it("says why a worker failed in the words a Lead's report uses", () => {
    expect(failedReason("billing")).toBe("failed: billing refused");
    expect(failedReason("auth")).toBe("failed: auth refused");
    expect(failedReason("usage_limit")).toBe("failed: usage limit reached");
    expect(failedReason("overloaded")).toBe("failed: API overloaded");
    expect(failedReason("provider_error")).toBe("failed: provider error");
  });

  it("knows its classes", () => {
    expect(isProviderErrorClass("billing")).toBe(true);
    expect(isProviderErrorClass("completed")).toBe(false);
    expect(isProviderErrorClass(undefined)).toBe(false);
  });

  it("writes a retry line a person can read", () => {
    expect(providerRetryText({ type: "provider.retry", attempt: 4, maxAttempts: 10, errorStatus: 529, errorClass: "overloaded" })).toBe(
      "API retry 4 of 10 · API overloaded (529)",
    );
    expect(providerRetryText({ type: "provider.retry", attempt: 2, maxAttempts: 10, errorStatus: 429, errorClass: "usage_limit" })).toBe(
      "API retry 2 of 10 · rate limited (429)",
    );
    expect(providerRetryText({ type: "provider.retry", attempt: 1, maxAttempts: 10, errorStatus: 503, errorClass: "provider_error" })).toBe(
      "API retry 1 of 10 · server error (503)",
    );
    expect(providerRetryText({ type: "provider.retry", attempt: 1, maxAttempts: 3, errorClass: "provider_error" })).toBe(
      "API retry 1 of 3 · connection problem",
    );
  });
});

describe("applying provider retries and notices", () => {
  it("keeps one retry line per turn and counts it up in place", () => {
    const session = apply(chat(), retry(1), retry(2), retry(3));
    const lines = session.blocks.filter((block) => block.role === "system");
    expect(lines.map((block) => block.text)).toEqual([
      "API retry 3 of 10 · API overloaded (529)",
    ]);
    expect(lines[0].notice).toBeUndefined();
  });

  it("starts a new retry line in the next turn", () => {
    let session = apply(chat(), retry(2));
    session = {
      ...session,
      blocks: [...session.blocks, { id: "u2", role: "user", text: "again" }],
    };
    session = apply(session, retry(1));
    expect(
      session.blocks
        .filter((block) => block.role === "system")
        .map((block) => block.text),
    ).toEqual([
      "API retry 2 of 10 · API overloaded (529)",
      "API retry 1 of 10 · API overloaded (529)",
    ]);
  });

  it("shows a notice as a quiet line, and a keyed notice replaces itself", () => {
    const session = apply(
      chat(),
      { type: "notice", text: "Hook output was truncated.", level: "warning" },
      { type: "notice", text: "Indexing 10%", key: "tool:1" },
      { type: "notice", text: "Indexing 90%", key: "tool:1" },
    );
    const lines = session.blocks.filter((block) => block.role === "system");
    expect(lines.map((block) => block.text)).toEqual([
      "Hook output was truncated.",
      "Indexing 90%",
    ]);
    expect(lines.every((block) => !block.notice)).toBe(true);
  });
});

describe("applying a classified provider error", () => {
  it("does not dress a billing failure up as a usage limit", () => {
    const session = apply(chat(), {
      type: "session.error",
      message: "Billing refused (402): Insufficient credits",
      errorClass: "billing",
      retryable: false,
    });
    expect(session.usageLimit).toBeUndefined();
    expect(session.blocks.at(-1)).toMatchObject({
      role: "system",
      notice: "error",
      text: "Billing refused (402): Insufficient credits",
    });
  });

  it("marks a usage limit failure as limited", () => {
    const session = apply(chat(), {
      type: "session.error",
      message: "Usage limit reached: You've hit your limit",
      errorClass: "usage_limit",
      retryable: true,
    });
    expect(session.usageLimit).toEqual({});
  });

  it("still reads an unclassified adapter's out-of-credit error as a limit", () => {
    const session = apply(chat(), {
      type: "session.error",
      message: "Monthly limit reached for this key",
    });
    expect(session.usageLimit).toEqual({});
  });
});
