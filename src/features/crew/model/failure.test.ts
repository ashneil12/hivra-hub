import { describe, expect, it } from "vitest";
import {
  classifyAdapterFailure,
  classifyFxFailure,
  classifyOpenaiFailure,
  classifyProviderFailure,
  claudeCodeDiagnosis,
  failureKind,
  hermesDiagnostic,
  jsonOutputDiagnostic,
  NOT_AUTHENTICATED,
  SERVER_ERROR,
} from "./failure";

describe("failure text", () => {
  it("does not treat a traceback or a bare auth substring as a signed-out CLI", () => {
    const output = [
      'File "production_authority.py", line 3, in login',
      "    return login()",
      "    at run (/app/index.js:401:17)",
      "command not found",
    ].join("\n");
    expect(classifyAdapterFailure("codex", output)).toBe("missing_cli");
    expect(classifyAdapterFailure("", "production_authority")).toBe("unknown");
    expect(classifyAdapterFailure("", "authentication failed")).toBe(NOT_AUTHENTICATED);
  });

  it("matches 401 and 429 on a boundary only", () => {
    expect(classifyAdapterFailure("", "error 401 from the api")).toBe(NOT_AUTHENTICATED);
    expect(classifyAdapterFailure("", "x401y")).toBe("unknown");
    expect(classifyAdapterFailure("", "status 429")).toBe("rate_limit");
    expect(classifyAdapterFailure("", "room 4291")).toBe("unknown");
  });

  it("keeps a worker's own JSON out of the diagnosis", () => {
    const stdout = ['{"result":"edited src/login.ts and hit a rate limit in the copy"}', "quota exceeded"].join("\n");
    const text = jsonOutputDiagnostic(stdout, claudeCodeDiagnosis);
    expect(text).not.toContain("login");
    expect(classifyAdapterFailure("claude-code", text)).toBe("billing_or_quota");
    const truncated = '{"error":\ncommand not found';
    expect(classifyAdapterFailure("", jsonOutputDiagnostic(truncated, claudeCodeDiagnosis))).toBe("missing_cli");
  });

  it("reads an error field, and not a worker answer", () => {
    const text = jsonOutputDiagnostic('{"type":"result","is_error":true,"error":"rate_limit"}', claudeCodeDiagnosis);
    expect(classifyAdapterFailure("claude-code", text)).toBe("rate_limit");
    expect(classifyFxFailure("", { error: "MissingCredentials" })).toBe(NOT_AUTHENTICATED);
    expect(classifyFxFailure("", { result: "rate limit in the answer" })).toBeNull();
  });

  it("treats an upstream block as a server error, not a dead key", () => {
    expect(classifyProviderFailure("http_status:401", null, "blocked by upstream provider")).toBe(SERVER_ERROR);
    expect(classifyProviderFailure("http_status:402")).toBe("billing_or_quota");
    expect(classifyOpenaiFailure("nope", 500)).toBe("openai_server_error");
    expect(classifyProviderFailure("timeout")).toBe("timeout");
  });

  it("uses hermes stderr once a turn ran", () => {
    expect(hermesDiagnostic("the answer mentions login", "boom\nsession_id: abc\n")).toBe("boom\nsession_id: abc\n");
    expect(hermesDiagnostic("not logged in", "setup")).toContain("not logged in");
  });
});

describe("failure kind", () => {
  it("reroutes account failures and never a task failure", () => {
    for (const cls of ["quota", "billing", "billing_or_quota", "rate_limit", "auth", "not_authenticated", "missing_cli", "credit"]) {
      expect(failureKind(cls), cls).toBe("account");
    }
    for (const cls of ["model_unavailable", "approval_denied", "sandbox_denied", "permission_denied", "unknown", "silent", ""]) {
      expect(failureKind(cls), cls).toBe("task");
    }
  });

  it("a timeout or an unreachable service is not a final failure", () => {
    expect(failureKind("timeout")).toBe("again");
    expect(failureKind("network_error")).toBe("again");
    expect(failureKind("overloaded")).toBe("again");
    expect(failureKind("provider_error")).toBe("again");
    expect(failureKind("provider_error", "quota exceeded")).toBe("account");
    expect(failureKind("", "timed out talking to the api")).toBe("again");
    expect(failureKind("usage_limit")).toBe("usage");
  });
});
