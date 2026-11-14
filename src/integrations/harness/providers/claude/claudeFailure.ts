import { PROVIDER_ERROR_LABEL } from "../../core/providerFailure";
import type { HarnessEvent, ProviderErrorClass } from "../../core/types";

/**
 * Honest turn results from Claude Code.
 *
 * Claude Code reports a failed API request (a 401, a 402, a usage limit, a 529
 * after its own retries, a gateway's 503) as a `result` with subtype "success"
 * and `is_error: true`, after an assistant message the CLI wrote itself with
 * the error text. Read as a success, a worker that never did the work reached
 * its Lead as completed. This reads `is_error`, `api_error_status`,
 * `terminal_reason` and the error text into one failure class, with whether a
 * later retry can work and when a refused usage window resets.
 *
 * After T3 Code's terminalStatusFromResult and providerFailureFromResult (MIT,
 * apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts), re-done on
 * MonoCode's types. T3 tells only usage limits apart from other provider
 * errors; a Lead also needs billing, auth and overload, because it must never
 * resend work refused for sign-in or billing, and should wait out an overload.
 */

export type ClaudeFailure = {
  errorClass: ProviderErrorClass;
  /** A later retry can work with nothing fixed first. Never for auth or billing. */
  retryable: boolean;
  /** Epoch ms a refused usage window resets, when known. */
  resetsAt?: number;
  /** HTTP status of the API error that ended the turn. */
  status?: number;
  /** One line for the chat and the Lead's report. */
  message: string;
};

export type ClaudeFailureContext = {
  /** A `rate_limit_event` refused the usage window during the turn. */
  usageLimit?: { resetsAt?: number } | null;
  /**
   * `error` on the turn's latest main-thread assistant message: the CLI's own
   * label for the request that failed ("authentication_failed", …).
   */
  assistantError?: string;
  /** Clock for a reset given as a duration. */
  now?: number;
};

/** The loop ending on one of these failed the turn, whatever `is_error` says. */
const FAILED_TERMINALS = new Map<string, string>([
  ["api_error", "Claude stopped after repeated API errors."],
  ["blocking_limit", "Claude stopped: the context window is full."],
  [
    "prompt_too_long",
    "Claude stopped: the prompt is longer than the model's context window.",
  ],
  [
    "rapid_refill_breaker",
    "Claude stopped: the context refilled too quickly after compaction.",
  ],
  [
    "image_error",
    "Claude stopped: an image in the conversation could not be processed.",
  ],
  ["model_error", "Claude stopped: the model returned an error."],
  [
    "malformed_tool_use_exhausted",
    "Claude stopped after repeated malformed tool calls.",
  ],
  ["budget_exhausted", "Claude stopped: the turn's token budget ran out."],
  [
    "structured_output_retry_exhausted",
    "Claude could not produce the requested structured output.",
  ],
  [
    "tool_deferred_unavailable",
    "Claude could not resume a deferred tool call: the tool is gone.",
  ],
  ["turn_setup_failed", "Claude could not start the turn."],
]);

/** What an error subtype means when the CLI lists no error text with it. */
const SUBTYPE_TEXT = new Map<string, string>([
  ["error_max_turns", "Claude stopped at its turn limit."],
  ["error_max_budget_usd", "Claude stopped at its spending budget."],
  [
    "error_max_structured_output_retries",
    "Claude could not produce the requested structured output.",
  ],
]);

/** The CLI's `error` label on its own error message, where it decides the class. */
const ASSISTANT_ERROR_CLASS = new Map<string, ProviderErrorClass>([
  ["authentication_failed", "auth"],
  ["oauth_org_not_allowed", "auth"],
  ["cloud_credential_error", "auth"],
  ["verification_required", "auth"],
  ["billing_error", "billing"],
  ["account_on_hold", "billing"],
  ["rate_limit", "usage_limit"],
  ["overloaded", "overloaded"],
]);

/** The result's typed `api_error`, where it decides the class. */
const API_ERROR_CLASS = new Map<string, ProviderErrorClass>([
  ["provider_credentials", "auth"],
  ["gateway_signin_required", "auth"],
  ["gateway_session_expired", "auth"],
  ["api_key_auth_disabled", "auth"],
  ["org_disabled_credential", "auth"],
  ["invalid_credential_header", "auth"],
  ["model_requires_usage_credits", "billing"],
  ["long_context_credits_required", "billing"],
  ["usage_limit_reached", "usage_limit"],
]);

const USAGE_LIMIT_TEXT = /hit your (?:(?:usage|weekly|daily|monthly) )?limit|usage limit reached/i;
const BILLING_TEXT =
  /credit balance is too low|insufficient[_ ](?:credits?|funds|balance|quota)|payment required|out of credits|requires more credits/i;
const AUTH_TEXT =
  /failed to authenticate|authentication_error|invalid (?:api key|x-api-key|bearer token)|invalid[_ ]api[_ ]key|incorrect api key|\bunauthori[sz]ed\b|oauth (?:access )?token (?:has been revoked|has expired|expired)|please run \/login|not logged in/i;
const OVERLOADED_TEXT = /overloaded_error|repeated 529|\boverloaded\b/i;
const CONNECTION_TEXT =
  /connection to the api was lost|request timed out|no response from api|connection error|econnreset|etimedout|socket hang up|fetch failed/i;
/** A gateway that answers its upstream's 429 with a 503 of its own. */
const GATEWAY_LIMIT = /\b503\b[^\n]*\[429\][^\n]*rate_limit_error/;
const RESET_AFTER = /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/;
/** Long enough for any provider's own sentence, short enough for one line. */
const DETAIL_MAX = 600;

/**
 * The failure a turn `result` reports, or null when the turn completed or was
 * interrupted.
 */
export function claudeFailureFromResult(
  rec: Record<string, unknown>,
  context: ClaudeFailureContext = {},
): ClaudeFailure | null {
  const subtype = text(rec.subtype) ?? "";
  const terminal = text(rec.terminal_reason) ?? "";
  // The CLI can label an abort "success"; its terminal reason wins.
  if (terminal === "aborted_streaming" || terminal === "aborted_tools") {
    return null;
  }
  const errors = (Array.isArray(rec.errors) ? rec.errors : []).filter(
    (item): item is string =>
      typeof item === "string" &&
      !!item.trim() &&
      // CLI telemetry, which the CLI hides from its own UI too.
      !item.startsWith("[ede_diagnostic]"),
  );
  if (subtype !== "success") {
    const joined = errors.join(" ").toLowerCase();
    if (joined.includes("interrupt") || joined.includes("cancel")) return null;
  }
  const errorTexts = [
    subtype === "success" && rec.is_error === true ? text(rec.result) : "",
    ...errors,
  ].filter((item): item is string => !!item?.trim());
  const status = apiStatus(rec.api_error_status, errorTexts);
  const failed =
    subtype !== "success" ||
    rec.is_error === true ||
    status !== undefined ||
    FAILED_TERMINALS.has(terminal);
  if (!failed) return null;

  const evidence: Evidence = {
    status,
    raw: errorTexts.join("\n"),
    terminal,
    assistantError: context.assistantError,
    apiError: text(rec.api_error),
    usageRefused: !!context.usageLimit,
  };
  const errorClass = classify(evidence);
  const resetsAt =
    errorClass === "usage_limit"
      ? (context.usageLimit?.resetsAt ??
        resetAfter(evidence.raw, context.now ?? Date.now()))
      : undefined;
  const plain =
    errorTexts[0] ??
    FAILED_TERMINALS.get(terminal) ??
    SUBTYPE_TEXT.get(subtype) ??
    "Claude turn failed.";
  // A failure that is not an API error keeps the CLI's words as they were.
  const labelled = errorClass !== "provider_error" || status !== undefined;
  return {
    errorClass,
    retryable: isRetryable(errorClass, evidence),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(status !== undefined ? { status } : {}),
    message: labelled
      ? `${sentence(PROVIDER_ERROR_LABEL[errorClass])}${status !== undefined ? ` (${status})` : ""}: ${readable(plain)}`
      : plain,
  };
}

/** An `api_retry` system message as a `provider.retry` event. */
export function claudeRetryFromMessage(
  rec: Record<string, unknown>,
): Extract<HarnessEvent, { type: "provider.retry" }> | null {
  if (text(rec.type) !== "system" || text(rec.subtype) !== "api_retry") {
    return null;
  }
  const attempt = Math.max(1, whole(rec.attempt) ?? 1);
  const status = whole(rec.error_status);
  const delay = whole(rec.retry_delay_ms);
  const error = text(rec.error);
  return {
    type: "provider.retry",
    attempt,
    // A first-byte timeout counts against its own, smaller cap.
    maxAttempts: Math.max(attempt, whole(rec.max_retries) ?? attempt),
    ...(status !== undefined ? { errorStatus: status } : {}),
    errorClass:
      status === 529 || error === "overloaded"
        ? "overloaded"
        : status === 429 || error === "rate_limit"
          ? "usage_limit"
          : status === 401 || status === 403 || error === "authentication_failed"
            ? "auth"
            : status === 402 || error === "billing_error"
              ? "billing"
              : "provider_error",
    ...(delay !== undefined && delay >= 0 ? { retryDelayMs: delay } : {}),
  };
}

type Evidence = {
  status?: number;
  raw: string;
  terminal: string;
  assistantError?: string;
  apiError?: string;
  usageRefused?: boolean;
};

function classify(evidence: Evidence): ProviderErrorClass {
  const { status, raw, terminal } = evidence;
  const byApiError = API_ERROR_CLASS.get(evidence.apiError ?? "");
  const byAssistant = ASSISTANT_ERROR_CLASS.get(evidence.assistantError ?? "");
  const clientError = status === undefined || (status >= 400 && status < 500);

  if (status === 402) return "billing";
  if (status === 401) return "auth";
  if (byApiError === "auth" || byApiError === "billing") return byApiError;
  if (byAssistant === "auth" || byAssistant === "billing") return byAssistant;
  if (clientError && BILLING_TEXT.test(raw)) return "billing";
  if (status === 403) return "auth";
  if (status === undefined && AUTH_TEXT.test(raw)) return "auth";

  if (status === 503 && GATEWAY_LIMIT.test(raw)) return "usage_limit";
  if (status === 429 || byApiError === "usage_limit") return "usage_limit";
  if (status === undefined) {
    if (byAssistant === "usage_limit" || USAGE_LIMIT_TEXT.test(raw)) {
      return "usage_limit";
    }
    // A refused window explains a failed request, not a full context.
    if (
      evidence.usageRefused &&
      ["", "completed", "api_error", "blocking_limit"].includes(terminal)
    ) {
      return "usage_limit";
    }
  }

  if (status === 529 || byAssistant === "overloaded") return "overloaded";
  if ((status === undefined || status >= 500) && OVERLOADED_TEXT.test(raw)) {
    return "overloaded";
  }
  return "provider_error";
}

function isRetryable(
  errorClass: ProviderErrorClass,
  evidence: Evidence,
): boolean {
  if (errorClass === "auth" || errorClass === "billing") return false;
  if (errorClass === "usage_limit" || errorClass === "overloaded") return true;
  const { status } = evidence;
  if (status !== undefined) {
    return status === 408 || status === 409 || status >= 500;
  }
  return (
    evidence.terminal === "api_error" ||
    evidence.assistantError === "server_error" ||
    evidence.apiError === "no_response" ||
    CONNECTION_TEXT.test(evidence.raw)
  );
}

/** HTTP status of the API error that ended the turn. */
function apiStatus(value: unknown, texts: string[]): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  ) {
    return value;
  }
  for (const item of texts) {
    const match = /\bAPI Error: (\d{3})\b/.exec(item);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** "(reset after 1h 2m 3s)" from a gateway, as epoch ms. */
function resetAfter(raw: string, now: number): number | undefined {
  const match = RESET_AFTER.exec(raw);
  if (!match) return undefined;
  const seconds =
    Number(match[1] ?? 0) * 3_600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  const at = now + seconds * 1_000;
  return seconds > 0 && Number.isFinite(at) ? at : undefined;
}

/**
 * The provider's own sentence: an error body's message in place of its JSON,
 * without the "API Error: 402" the label already says.
 */
function readable(value: string): string {
  let line = value.trim();
  // A router can wrap its upstream's error body in its own.
  for (let pass = 0; pass < 3; pass += 1) {
    const start = line.search(/\{\s*"(?:type|error)"/);
    const end = start < 0 ? -1 : jsonObjectEnd(line, start);
    const message = end < 0 ? undefined : errorMessage(line.slice(start, end + 1));
    if (!message) break;
    line = `${line.slice(0, start)}${message}${line.slice(end + 1)}`;
  }
  line = line.replace(/\bAPI Error: (?:\d{3} )?/, "").trim();
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

function errorMessage(json: string): string | undefined {
  try {
    const body = JSON.parse(json) as Record<string, unknown>;
    const error =
      body.error && typeof body.error === "object"
        ? (body.error as Record<string, unknown>)
        : undefined;
    const message = error?.message ?? body.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Index of the brace closing the JSON object that opens at `start`. */
function jsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function sentence(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}
