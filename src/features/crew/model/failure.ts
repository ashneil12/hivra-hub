// Translated from Puppetmaster puppetmaster/failure.py (MIT).
// Copyright (c) 2026 Cary
//
// Python became TypeScript. The checks, their order and the edge cases are the
// original's: traceback frames are not the failure, a bare "auth" or "login" is
// not a signed-out CLI, 401 and 429 need a boundary, a worker's own JSON is not
// a diagnosis, and "blocked by upstream provider" is a server error, not a dead key.

export const NOT_AUTHENTICATED = "not_authenticated";
export const MISSING_CLI = "missing_cli";
export const RATE_LIMIT = "rate_limit";
export const BILLING_OR_QUOTA = "billing_or_quota";
export const MODEL_UNAVAILABLE = "model_unavailable";
export const APPROVAL_DENIED = "approval_denied";
export const SANDBOX_DENIED = "sandbox_denied";
export const TIMEOUT = "timeout";
export const NETWORK_ERROR = "network_error";
export const MALFORMED_RESPONSE = "malformed_response";
export const SERVER_ERROR = "server_error";
export const CONTEXT_LENGTH_EXCEEDED = "context_length_exceeded";
export const PERMISSION_DENIED = "permission_denied";
export const FORBIDDEN = "forbidden";
export const OPENAI_SERVER_ERROR = "openai_server_error";
export const SDK_NOT_INSTALLED = "sdk_not_installed";
export const RUN_STATUS_ERROR = "run_status_error";
export const UNKNOWN = "unknown";

export type FailureKind = "account" | "usage" | "again" | "task";

const AUTH_DIAGNOSIS =
  /\b(?:auth|authentication|authorization|login|log in|sign in|token|api[ _-]key)[ _-]?(?:error|failed|failure|required|expired|revoked|invalid|missing)\b|\b(?:please |re-?)(?:authenticate|log ?in|sign ?in)\b|\b(?:invalid|incorrect|missing|no)[ _-](?:api[ _-]key|token|credentials?)\b|\binvalid authentication\b|\b(?:login|account|provider|credentials?) verification (?:failed|required)\b/;

const TRACEBACK_FRAME = /^\s*File "[^"\n]*", line \d+(?:, in [^\n]*)?$/;
const NODE_STACK_FRAME = /^\s+at .*:\d+:\d+\)?$/;
type Checker = (lowered: string) => boolean;
type Rule = [Checker, string];

function anyOf(...parts: string[]): Checker {
  return (lowered) => parts.some((part) => lowered.includes(part));
}

function allOf(...parts: string[]): Checker {
  return (lowered) => parts.every((part) => lowered.includes(part));
}

function matches(pattern: RegExp): Checker {
  return (lowered) => pattern.test(lowered);
}

function withoutTracebackFrames(text: string): string {
  const kept: string[] = [];
  let inFrame = false;
  for (const line of text.split("\n")) {
    if (TRACEBACK_FRAME.test(line)) {
      inFrame = true;
      continue;
    }
    if (inFrame && line.startsWith("    ")) continue;
    inFrame = false;
    if (NODE_STACK_FRAME.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function modelUnavailable(lowered: string): boolean {
  return (
    lowered.includes("model") &&
    (lowered.includes("unavailable") ||
      lowered.includes("not found") ||
      lowered.includes("invalid") ||
      lowered.includes("does not exist") ||
      lowered.includes("not supported") ||
      lowered.includes("404"))
  );
}

const BASE_RULES: Rule[] = [
  [anyOf("command not found"), MISSING_CLI],
  [anyOf("not logged in", "codex login", "missing bearer", "unauthorized"), NOT_AUTHENTICATED],
  [matches(/(?<![\w.])401(?![\w.])/), NOT_AUTHENTICATED],
  [anyOf("not authenticated", "please login", "hermes login", "missing credentials"), NOT_AUTHENTICATED],
  [anyOf("cursor_api_key"), NOT_AUTHENTICATED],
  [matches(AUTH_DIAGNOSIS), NOT_AUTHENTICATED],
  [anyOf("context length", "maximum context", "context window"), CONTEXT_LENGTH_EXCEEDED],
  [anyOf("rate limit"), RATE_LIMIT],
  [matches(/(?<![\w.])429(?![\w.])/), RATE_LIMIT],
  [anyOf("billing", "quota", "credit"), BILLING_OR_QUOTA],
  [anyOf("model_not_found"), MODEL_UNAVAILABLE],
  [modelUnavailable, MODEL_UNAVAILABLE],
  [allOf("approval", "denied"), APPROVAL_DENIED],
  [allOf("approval", "rejected"), APPROVAL_DENIED],
  [allOf("sandbox", "denied"), SANDBOX_DENIED],
  [allOf("sandbox", "blocked"), SANDBOX_DENIED],
  [anyOf("timeout", "timed out"), TIMEOUT],
  [anyOf("network", "dns", "connect"), NETWORK_ERROR],
];

const ADAPTER_EXTRA: Record<string, Rule[]> = {
  cursor: [
    [anyOf("cannot find package"), SDK_NOT_INSTALLED],
    [allOf("@cursor/sdk", "not found"), SDK_NOT_INSTALLED],
    [anyOf("forbidden-model"), MODEL_UNAVAILABLE],
    [allOf("forbidden", "model"), MODEL_UNAVAILABLE],
    [allOf("not permitted", "model"), MODEL_UNAVAILABLE],
    [allOf("not allowed", "model"), MODEL_UNAVAILABLE],
    [allOf("unavailable", "model"), MODEL_UNAVAILABLE],
    [allOf("unknown", "model"), MODEL_UNAVAILABLE],
    [allOf("status", "error"), RUN_STATUS_ERROR],
  ],
  "claude-code": [
    [anyOf("not_found_error", "permission_error"), MODEL_UNAVAILABLE],
    [allOf("permission", "model"), MODEL_UNAVAILABLE],
    [allOf("not allowed", "model"), MODEL_UNAVAILABLE],
    [allOf("denied", "model"), MODEL_UNAVAILABLE],
    [anyOf("permission", "not allowed", "denied"), PERMISSION_DENIED],
  ],
  codex: [[anyOf("spend cap"), BILLING_OR_QUOTA]],
  hermes: [
    [allOf("no such file or directory", "hermes"), MISSING_CLI],
    [
      anyOf(
        "no provider",
        "provider credentials",
        "no inference provider is configured",
        "no api key found for provider",
        "provider resolution failed",
      ),
      NOT_AUTHENTICATED,
    ],
  ],
  openai: [],
  antigravity: [
    [anyOf("not recognized as a known model", "invalid model selection"), MODEL_UNAVAILABLE],
    [anyOf("requires --effort", "invalid effort"), MODEL_UNAVAILABLE],
    [anyOf("not authenticated", "please authenticate", "login to", "oauth"), NOT_AUTHENTICATED],
    [anyOf("high demand", "error 503", "status: unavailable"), RATE_LIMIT],
    [anyOf("jetski:", "headless mode cannot prompt", "user denied permission"), PERMISSION_DENIED],
  ],
};

function classify(output: string, rules: readonly Rule[]): string {
  const lowered = withoutTracebackFrames(output || "").toLowerCase();
  for (const [checker, category] of rules) {
    if (checker(lowered)) return category;
  }
  return UNKNOWN;
}

export function classifyAdapterFailure(adapter: string, output: string): string {
  return classify(output, [...(ADAPTER_EXTRA[adapter] ?? []), ...BASE_RULES]);
}

function errorText(value: unknown): string {
  let text = value;
  if (text && typeof text === "object") {
    const record = text as Record<string, unknown>;
    text = record.message || record.type;
  }
  if (typeof text !== "string") return "";
  return /^[a-z_]+$/.test(text) ? text.replace(/_/g, " ") : text;
}

export function jsonOutputDiagnostic(
  stdout: string | null | undefined,
  diagnosis: (event: Record<string, unknown>) => unknown[],
): string {
  const lines: string[] = [];
  for (const raw of (stdout ?? "").split("\n")) {
    if (!raw.trim().startsWith("{")) {
      lines.push(raw);
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event && typeof event === "object" && !Array.isArray(event)) {
      for (const part of diagnosis(event as Record<string, unknown>)) {
        if (part) lines.push(String(part));
      }
    }
  }
  return lines.join("\n");
}

export function claudeCodeDiagnosis(event: Record<string, unknown>): unknown[] {
  const parts: unknown[] = [errorText(event.error)];
  if (event.type === "result" && event.is_error) {
    parts.push(event.subtype, event.result);
    const errors = Array.isArray(event.errors) ? event.errors : [];
    parts.push(...errors.map((item) => errorText(item)));
  }
  return parts;
}

export function cursorDiagnosis(event: Record<string, unknown>): unknown[] {
  const status = event.status;
  const parts: unknown[] = [
    status != null ? `status: ${String(status)}` : "",
    errorText(event.error),
    errorText(event.message),
  ];
  if (String(status).toLowerCase() === "error") parts.push(event.result);
  return parts;
}

export function antigravityDiagnosis(event: Record<string, unknown>): unknown[] {
  return [errorText(event.error), event.status];
}

export function hermesDiagnostic(stdout: string | null | undefined, stderr: string | null | undefined): string {
  const err = stderr ?? "";
  if (/^session_id: /m.test(err)) return err;
  return `${err}\n${stdout ?? ""}`;
}

export function classifyFxFailure(stderr: string, result: Record<string, unknown> | null | undefined): string | null {
  const row = result && typeof result === "object" ? result : {};
  const error = row.error;
  if ((row.auth_failure && typeof row.auth_failure === "object") || error === "MissingCredentials") {
    return NOT_AUTHENTICATED;
  }
  const code = typeof error === "string" ? error.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ").toLowerCase() : "";
  const failure = classifyAdapterFailure("fx", [stderr || "", code].filter(Boolean).join("\n"));
  return failure === UNKNOWN ? null : failure;
}

const UPSTREAM_BLOCK = ["blocked by upstream provider", "request blocked by upstream"];

export function isUpstreamProviderBlock(message?: string | null): boolean {
  const msg = (message ?? "").toLowerCase();
  return UPSTREAM_BLOCK.some((pattern) => msg.includes(pattern));
}

export function isServerErrorFailure(failure: string): boolean {
  return failure === SERVER_ERROR || failure === OPENAI_SERVER_ERROR;
}

export function classifyOpenaiFailure(body: string, httpStatus?: number | null): string {
  if (httpStatus === 401) return NOT_AUTHENTICATED;
  if (httpStatus === 403) return FORBIDDEN;
  if (httpStatus === 404) return MODEL_UNAVAILABLE;
  if (httpStatus === 429) return RATE_LIMIT;
  if (httpStatus != null && httpStatus >= 500 && httpStatus < 600) return OPENAI_SERVER_ERROR;
  return classifyAdapterFailure("openai", body);
}

export function classifyProviderFailure(reason: string, httpStatus?: number | null, body = ""): string {
  let status = httpStatus ?? null;
  if (status == null && reason.startsWith("http_status:")) {
    const parsed = Number(reason.slice("http_status:".length));
    if (Number.isInteger(parsed)) status = parsed;
  }
  if (isUpstreamProviderBlock(body) || isUpstreamProviderBlock(reason)) return SERVER_ERROR;
  if (status === 401) return NOT_AUTHENTICATED;
  if (status === 402) return BILLING_OR_QUOTA;
  if (status === 403) return FORBIDDEN;
  if (status === 404) return MODEL_UNAVAILABLE;
  if (status === 429) return RATE_LIMIT;
  if (status != null && status >= 500 && status < 600) return SERVER_ERROR;
  if (status != null && status >= 400 && status < 500) {
    const failure = classifyAdapterFailure("openai", body);
    if (failure !== UNKNOWN) return failure;
  }
  const byReason: Record<string, string> = {
    not_authenticated: NOT_AUTHENTICATED,
    timeout: TIMEOUT,
    network_error: NETWORK_ERROR,
    malformed_response: MALFORMED_RESPONSE,
    openai_server_error: SERVER_ERROR,
    server_error: SERVER_ERROR,
    unsupported_model: MODEL_UNAVAILABLE,
  };
  return byReason[reason] ?? (reason || UNKNOWN);
}

/** The hub stores a class as lowercase letters, digits and underscores, at most 40. */
export function sanitizeClass(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 40);
}

const ACCOUNT = new Set([
  "quota",
  "billing",
  BILLING_OR_QUOTA,
  "credit",
  "credits",
  "out_of_credits",
  RATE_LIMIT,
  "ratelimit",
  "rate_limited",
  "auth",
  NOT_AUTHENTICATED,
  "unauthenticated",
  "login",
  "unauthorized",
  MISSING_CLI,
  "cli_missing",
  "command_not_found",
  SDK_NOT_INSTALLED,
]);

const AGAIN = new Set([
  TIMEOUT,
  "timed_out",
  "network",
  NETWORK_ERROR,
  "unreachable",
  "dns",
  "overloaded",
  SERVER_ERROR,
  OPENAI_SERVER_ERROR,
]);

/**
 * Account failures can move to another CLI. A usage limit can pause. A timeout
 * or an unreachable service is tried again on the same CLI. Anything else is
 * the work itself and never reroutes.
 */
export function failureKind(errorClass: string | null | undefined, text?: string | null): FailureKind {
  const cls = sanitizeClass(errorClass);
  if (cls === "usage_limit") return "usage";
  if (ACCOUNT.has(cls)) return "account";
  if (AGAIN.has(cls)) return "again";
  if (cls === "" || cls === "provider_error" || cls === "unknown") {
    if (!text) return cls === "provider_error" ? "again" : "task";
    const found = classifyAdapterFailure("", text);
    if (found === UNKNOWN) return cls === "provider_error" ? "again" : "task";
    return failureKind(found);
  }
  return "task";
}

