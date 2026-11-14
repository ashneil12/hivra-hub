import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  claudeFailureFromResult,
  claudeRetryFromMessage,
} from "./claudeFailure";
import { turnStatusFromResult } from "./claudeProtocol";

/**
 * T3 Code's recorded `claude_result_is_error` transcript, copied verbatim with
 * its MIT notice (fixtures/t3code/LICENSE) from github.com/pingdotgg/t3code at
 * 2532e640, apps/server/src/orchestration-v2/testkit/fixtures/
 * claude_result_is_error/claude_transcript.ndjson. Run 1 is a 401 the SDK
 * reports as subtype "success" with is_error; run 2 is the recovered turn.
 */
function t3Frames(): Record<string, Record<string, unknown>> {
  const raw = readFileSync(
    new URL("./fixtures/t3code/claude_result_is_error.ndjson", import.meta.url),
    "utf8",
  );
  const frames: Record<string, Record<string, unknown>> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as {
      type: string;
      label?: string;
      frame?: Record<string, unknown>;
    };
    if (entry.type === "emit_inbound" && entry.label && entry.frame) {
      frames[entry.label] = entry.frame;
    }
  }
  return frames;
}

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

function apiErrorResult(
  status: number | null,
  result: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: status,
    num_turns: 1,
    result,
    stop_reason: "stop_sequence",
    terminal_reason: "api_error",
    ...extra,
  };
}

const BILLING_402 = apiErrorResult(
  402,
  'API Error: 402 {"type":"error","error":{"type":"api_error","message":"openrouter.ai said: Insufficient credits. Add more using https://openrouter.ai/settings/credits"}}',
);
const OVERLOADED_529 = apiErrorResult(
  529,
  "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
);
const GATEWAY_503 = apiErrorResult(
  503,
  "API Error: 503 upstream connect error or disconnect/reset before headers. reset reason: connection termination. This is a server-side issue, usually temporary — try again in a moment.",
);
const GATEWAY_LIMIT_503 = apiErrorResult(
  503,
  'API Error: 503 [litellm] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached for claude-opus-5"}} (reset after 1h 2m 3s)',
);

describe("claudeFailureFromResult on T3's claude_result_is_error fixture", () => {
  const frames = t3Frames();

  it("fails the 401 the CLI labels success, as auth that is never retried", () => {
    const failure = claudeFailureFromResult(frames["result:1_is_error"], {
      assistantError: "authentication_failed",
    });
    expect(failure).toEqual({
      errorClass: "auth",
      retryable: false,
      status: 401,
      message:
        "Auth refused (401): Failed to authenticate. Invalid authentication credentials",
    });
    // The status alone is enough when the CLI's error frame is not seen.
    expect(claudeFailureFromResult(frames["result:1_is_error"])?.errorClass).toBe(
      "auth",
    );
    expect(turnStatusFromResult(frames["result:1_is_error"]).status).toBe(
      "failed",
    );
  });

  it("leaves the recovered turn completed", () => {
    expect(claudeFailureFromResult(frames["result:2_success"])).toBeNull();
    expect(turnStatusFromResult(frames["result:2_success"])).toEqual({
      status: "completed",
    });
  });
});

describe("claudeFailureFromResult", () => {
  it("reads a 402 as billing refused, never retried", () => {
    const failure = claudeFailureFromResult(BILLING_402);
    expect(failure).toMatchObject({
      errorClass: "billing",
      retryable: false,
      status: 402,
    });
    expect(failure?.message).toBe(
      "Billing refused (402): openrouter.ai said: Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    );
    expect(failure?.resetsAt).toBeUndefined();
  });

  it("reads Claude's own out-of-credit error as billing", () => {
    expect(
      claudeFailureFromResult(apiErrorResult(null, "Credit balance is too low"), {
        assistantError: "billing_error",
      }),
    ).toMatchObject({ errorClass: "billing", retryable: false });
    expect(
      claudeFailureFromResult(apiErrorResult(400, "Credit balance is too low")),
    ).toMatchObject({ errorClass: "billing", retryable: false });
  });

  it("keeps a 401 or a 402 out of the usage limit even after a refused window", () => {
    const refused = { usageLimit: { resetsAt: NOW + 60_000 }, now: NOW };
    expect(claudeFailureFromResult(BILLING_402, refused)).toMatchObject({
      errorClass: "billing",
      retryable: false,
    });
    expect(claudeFailureFromResult(BILLING_402, refused)?.resetsAt).toBeUndefined();
    expect(
      claudeFailureFromResult(
        apiErrorResult(401, "Failed to authenticate. API Error: 401 Invalid bearer token"),
        refused,
      ),
    ).toMatchObject({ errorClass: "auth", retryable: false });
  });

  it("reads a 529 as an overload worth retrying", () => {
    expect(claudeFailureFromResult(OVERLOADED_529)).toEqual({
      errorClass: "overloaded",
      retryable: true,
      status: 529,
      message:
        "API overloaded (529): Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
    });
  });

  it("reads a gateway's 503 as a retryable provider error", () => {
    expect(claudeFailureFromResult(GATEWAY_503)).toMatchObject({
      errorClass: "provider_error",
      retryable: true,
      status: 503,
    });
    expect(claudeFailureFromResult(GATEWAY_503)?.message).toMatch(
      /^Provider error \(503\): upstream connect error/,
    );
  });

  it("reads a gateway's 503 that wraps a 429 as a usage limit with its reset", () => {
    expect(claudeFailureFromResult(GATEWAY_LIMIT_503, { now: NOW })).toMatchObject(
      {
        errorClass: "usage_limit",
        retryable: true,
        resetsAt: NOW + (3_600 + 2 * 60 + 3) * 1_000,
      },
    );
  });

  it("reads a usage limit, taking the reset from the refused window", () => {
    const limited = apiErrorResult(
      null,
      "You've hit your limit · resets 3am (Europe/Sofia)",
      { terminal_reason: "completed" },
    );
    expect(
      claudeFailureFromResult(limited, {
        usageLimit: { resetsAt: 1_790_000_000_000 },
        assistantError: "rate_limit",
      }),
    ).toEqual({
      errorClass: "usage_limit",
      retryable: true,
      resetsAt: 1_790_000_000_000,
      message: "Usage limit reached: You've hit your limit · resets 3am (Europe/Sofia)",
    });
    expect(claudeFailureFromResult(limited)).toMatchObject({
      errorClass: "usage_limit",
    });
    expect(
      claudeFailureFromResult({ ...limited, is_error: false, terminal_reason: "completed", api_error_status: null }),
    ).toBeNull();
  });

  it("reads a 429 as a usage limit", () => {
    expect(
      claudeFailureFromResult(
        apiErrorResult(429, "API Error: Request rejected (429) · this may be a temporary capacity issue."),
      ),
    ).toMatchObject({ errorClass: "usage_limit", retryable: true, status: 429 });
  });

  it("keeps the plain error text for failures that are not API errors", () => {
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user", "Tool runner crashed"],
      }),
    ).toEqual({
      errorClass: "provider_error",
      retryable: false,
      message: "Tool runner crashed",
    });
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: [],
      })?.message,
    ).toBe("Claude stopped at its turn limit.");
  });

  it("fails a turn the loop ended on an error even without is_error", () => {
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "prompt_too_long",
        result: "",
      }),
    ).toMatchObject({ errorClass: "provider_error", retryable: false });
  });

  it("is not a failure when the turn was interrupted", () => {
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "aborted_streaming",
        result: "",
      }),
    ).toBeNull();
    expect(
      turnStatusFromResult({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "aborted_tools",
      }).status,
    ).toBe("interrupted");
  });
});

describe("turnStatusFromResult", () => {
  it("returns the failure with its class for an API error the CLI calls success", () => {
    const status = turnStatusFromResult(BILLING_402);
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/^Billing refused \(402\)/);
    expect(status.failure).toMatchObject({ errorClass: "billing" });
  });
});

describe("claudeRetryFromMessage", () => {
  it("turns an api_retry message into a provider.retry event", () => {
    expect(
      claudeRetryFromMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 4,
        max_retries: 10,
        retry_delay_ms: 8_000,
        error_status: 529,
        error: "overloaded",
        uuid: "u",
        session_id: "s",
      }),
    ).toEqual({
      type: "provider.retry",
      attempt: 4,
      maxAttempts: 10,
      errorStatus: 529,
      errorClass: "overloaded",
      retryDelayMs: 8_000,
    });
  });

  it("classes a connection retry and a rate limit retry", () => {
    expect(
      claudeRetryFromMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: null,
        error: "unknown",
      }),
    ).toEqual({
      type: "provider.retry",
      attempt: 1,
      maxAttempts: 10,
      errorClass: "provider_error",
      retryDelayMs: 500,
    });
    expect(
      claudeRetryFromMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1_000,
        error_status: 429,
        error: "rate_limit",
      })?.errorClass,
    ).toBe("usage_limit");
  });

  it("ignores other system messages", () => {
    expect(
      claudeRetryFromMessage({ type: "system", subtype: "status", status: "requesting" }),
    ).toBeNull();
  });
});

it("classifies the CLI's weekly-limit wording as a usage refusal", () => {
  expect(claudeFailureFromResult(apiErrorResult(null, "You've hit your weekly limit · resets Nov 17 at 1am (Europe/London)"))).toMatchObject({errorClass: "usage_limit", retryable: true});
});
