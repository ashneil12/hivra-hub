import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import type { HarnessEvent } from "../../core/types";
import { newSession, type Session } from "../../../../features/sessions/model/session";
import type { ControlOutcome } from "../../../../features/orchestration/model/orchestration";
import { monoSessionCompletionResult } from "../../../../features/monos/model/monoSessionCompletion";

/**
 * Honest turn results end to end through the live Claude adapter: what the
 * CLI streams for an API failure, a retry or a notice, and what the chat
 * shows for it. The CLI is faked at the child-process seam.
 */

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import(
  "./claude"
);

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function userPrompts() {
  return parse().filter((m) => m.type === "user").length;
}

async function startTurn(sessionId: string, text = "do the work") {
  const events: HarnessEvent[] = [];
  const prompts = userPrompts();
  const fresh = !onLine;
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "full-access",
    text,
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  if (fresh) {
    await waitFor(
      () =>
        parse().some(
          (m) =>
            (m.request as Record<string, unknown> | undefined)?.subtype ===
            "initialize",
        ),
      "initialize",
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: "monocode_1" },
    });
  }
  await waitFor(() => userPrompts() > prompts, "user prompt");
  return { events, turn };
}

function render(events: HarnessEvent[]): Session {
  let session: Session = {
    ...newSession("claude", "/repo"),
    blocks: [{ id: "u1", role: "user", text: "do the work" }],
  };
  for (const event of events) session = applyHarnessEvent(session, event);
  return session;
}

function errorsOf(events: HarnessEvent[]) {
  return events.filter(
    (event): event is Extract<HarnessEvent, { type: "session.error" }> =>
      event.type === "session.error",
  );
}

/** What the CLI streams for a request that failed for good. */
function emitApiFailure(
  text: string,
  result: Record<string, unknown>,
  assistantError = "unknown",
) {
  emit({
    type: "assistant",
    session_id: "sess_1",
    parent_tool_use_id: null,
    error: assistantError,
    message: {
      id: "msg_synthetic",
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  emit({
    type: "result",
    subtype: "success",
    session_id: "sess_1",
    is_error: true,
    num_turns: 1,
    result: text,
    terminal_reason: "api_error",
    ...result,
  });
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("worker");
});

describe("T3's claude_result_is_error transcript through the live adapter", () => {
  /** emit_inbound frames per prompt, in order; MIT notice in fixtures/t3code/LICENSE. */
  function framesByPrompt(): Record<string, unknown>[][] {
    const raw = readFileSync(
      new URL(
        "./fixtures/t3code/claude_result_is_error.ndjson",
        import.meta.url,
      ),
      "utf8",
    );
    const turns: Record<string, unknown>[][] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        type: string;
        label?: string;
        frame?: Record<string, unknown>;
      };
      if (entry.type === "expect_outbound" && entry.label?.startsWith("prompt.offer")) {
        turns.push([]);
      } else if (entry.type === "emit_inbound" && entry.frame) {
        turns[turns.length - 1].push(entry.frame);
      }
    }
    return turns;
  }

  it("fails the 401 turn as auth and completes the recovered one", async () => {
    const [failedFrames, recoveredFrames] = framesByPrompt();

    const first = await startTurn("worker", "Say hello before the credentials expire.");
    for (const frame of failedFrames) emit(frame);
    await first.turn;

    expect(errorsOf(first.events)).toEqual([
      {
        type: "session.error",
        message:
          "Auth refused (401): Failed to authenticate. Invalid authentication credentials",
        errorClass: "auth",
        retryable: false,
      },
    ]);
    expect(first.events.some((event) => event.type === "usage.limited")).toBe(
      false,
    );
    const shown = render(first.events);
    expect(
      shown.blocks
        .filter((block) => block.role === "assistant")
        .map((block) => block.text),
    ).toEqual([
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    ]);
    expect(shown.blocks.at(-1)).toMatchObject({
      role: "system",
      notice: "error",
      text: "Auth refused (401): Failed to authenticate. Invalid authentication credentials",
    });

    const second = await startTurn("worker", "Try again now that auth is back.");
    for (const frame of recoveredFrames) emit(frame);
    await second.turn;

    expect(errorsOf(second.events)).toEqual([]);
    expect(
      second.events
        .filter((event) => event.type === "message.delta")
        .map((event) => (event as { text: string }).text)
        .join(""),
    ).toBe("claude result is_error fixture recovered");
  });
});

/**
 * Recorded on 19 Oct 2026 from the installed Claude Code 2.1.302 (`claude
 * --bare -p --output-format stream-json`, a fake key, a scratch HOME,
 * CLAUDE_CODE_MAX_RETRIES=2) against a local fake API that failed every
 * request one way. Only the api_retry, assistant and result frames are kept.
 */
function recorded(name: string): Record<string, unknown>[] {
  return readFileSync(
    new URL(`./fixtures/claude-cli-2.1.302/${name}.ndjson`, import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("real Claude Code 2.1.302 failures through the live adapter", () => {
  it.each([
    [
      "402-billing",
      {
        errorClass: "billing",
        retryable: false,
        message: "Billing refused (402): openrouter.ai said: Insufficient credits",
      },
      [],
    ],
    [
      "401-auth",
      {
        errorClass: "auth",
        retryable: false,
        message: "Auth refused (401): Invalid API key · Fix external API key",
      },
      ["API retry 2 of 2 · auth refused (401)"],
    ],
    [
      "529-overloaded",
      { errorClass: "overloaded", retryable: true },
      ["API retry 2 of 2 · API overloaded (529)"],
    ],
    [
      "503-gateway",
      { errorClass: "provider_error", retryable: true },
      ["API retry 2 of 2 · server error (503)"],
    ],
  ] as const)(
    "reports %s as failed, never completed",
    async (name, expected, retryLines) => {
      const { events, turn } = await startTurn("worker");
      for (const frame of recorded(name)) emit(frame);
      await turn;

      const errors = errorsOf(events);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject(expected);
      expect(errors[0]).not.toHaveProperty("resetsAt");
      expect(events.some((event) => event.type === "usage.limited")).toBe(
        false,
      );
      expect(
        render(events)
          .blocks.filter((block) => block.role === "system" && !block.notice)
          .map((block) => block.text),
      ).toEqual(retryLines);
    },
  );

  it("reads a gateway's 503 wrapping a 429 as a usage limit that resets", async () => {
    const { events, turn } = await startTurn("worker");
    const before = Date.now();
    for (const frame of recorded("503-gateway-429-limit")) emit(frame);
    await turn;
    const after = Date.now();

    const [error] = errorsOf(events);
    expect(error).toMatchObject({ errorClass: "usage_limit", retryable: true });
    const window = (1 * 3_600 + 2 * 60 + 3) * 1_000;
    expect(error.resetsAt).toBeGreaterThanOrEqual(before + window);
    expect(error.resetsAt).toBeLessThanOrEqual(after + window);
    expect(events.filter((event) => event.type === "usage.limited")).toEqual([
      { type: "usage.limited", resetsAt: error.resetsAt },
    ]);
  });

  it("reaches the Lead's report as failed: billing refused", async () => {
    // Loaded here so the rest of this file runs on code that predates it.
    const { providerFailureOf, withProviderFailure } = await import(
      "../../../../app/model/turnFailure"
    );
    const { events, turn } = await startTurn("worker");
    for (const frame of recorded("402-billing")) emit(frame);
    await turn;

    // What App.tsx does with a monitored turn's events, then its report.
    let outcome: ControlOutcome = {
      status: "failed",
      text: "",
      error: "Turn did not complete",
    };
    for (const event of events) {
      if (event.type === "session.error") {
        outcome = withProviderFailure(outcome, event);
      }
    }
    const report = monoSessionCompletionResult({
      requestId: "app-lead-1",
      sessionId: "worker",
      project: "/repo",
      prompt: "do the work",
      outcome: {
        status: "failed",
        text: "API Error: 402 openrouter.ai said: Insufficient credits",
        ...providerFailureOf(outcome),
      },
    });
    expect(report).toMatchObject({
      status: "failed",
      reason: "failed: billing refused",
      errorClass: "billing",
      retryable: false,
      error: "Billing refused (402): openrouter.ai said: Insufficient credits",
    });
  });
});

describe("honest Claude turn results", () => {
  it("reports a 402 as billing refused and never as a usage limit", async () => {
    const { events, turn } = await startTurn("worker");
    // A refused window must not turn a billing failure into a resumable limit.
    emit({
      type: "rate_limit_event",
      session_id: "sess_1",
      rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000 },
    });
    emitApiFailure(
      'API Error: 402 {"type":"error","error":{"type":"api_error","message":"openrouter.ai said: Insufficient credits"}}',
      { api_error_status: 402 },
    );
    await turn;

    expect(errorsOf(events)).toEqual([
      {
        type: "session.error",
        message: "Billing refused (402): openrouter.ai said: Insufficient credits",
        errorClass: "billing",
        retryable: false,
      },
    ]);
    expect(events.some((event) => event.type === "usage.limited")).toBe(false);
    const shown = render(events);
    expect(shown.usageLimit).toBeUndefined();
    expect(shown.blocks.at(-1)).toMatchObject({
      role: "system",
      notice: "error",
      text: "Billing refused (402): openrouter.ai said: Insufficient credits",
    });
  });

  it("shows API retries as one line that counts up, then fails a 529 as overloaded", async () => {
    const { events, turn } = await startTurn("worker");
    for (const attempt of [1, 2, 3]) {
      emit({
        type: "system",
        subtype: "api_retry",
        attempt,
        max_retries: 10,
        retry_delay_ms: 1_000 * attempt,
        error_status: 529,
        error: "overloaded",
        uuid: `retry-${attempt}`,
        session_id: "sess_1",
      });
    }
    emitApiFailure(
      "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
      { api_error_status: 529 },
      "overloaded",
    );
    await turn;

    expect(
      events.filter((event) => event.type === "provider.retry"),
    ).toEqual(
      [1, 2, 3].map((attempt) => ({
        type: "provider.retry",
        attempt,
        maxAttempts: 10,
        errorStatus: 529,
        errorClass: "overloaded",
        retryDelayMs: 1_000 * attempt,
      })),
    );
    expect(errorsOf(events)).toMatchObject([
      { errorClass: "overloaded", retryable: true },
    ]);
    const lines = render(events)
      .blocks.filter((block) => block.role === "system" && !block.notice)
      .map((block) => block.text);
    expect(lines).toEqual(["API retry 3 of 10 · API overloaded (529)"]);
  });

  it("reports a usage limit with its reset, so resume-at-reset still works", async () => {
    const { events, turn } = await startTurn("worker");
    emit({
      type: "rate_limit_event",
      session_id: "sess_1",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1_790_000_000,
        rateLimitType: "five_hour",
      },
    });
    emitApiFailure(
      "You've hit your limit · resets 3am (Europe/Sofia)",
      { api_error_status: null, terminal_reason: "completed" },
      "rate_limit",
    );
    await turn;

    expect(errorsOf(events)).toMatchObject([
      {
        errorClass: "usage_limit",
        retryable: true,
        resetsAt: 1_790_000_000_000,
      },
    ]);
    expect(events.filter((event) => event.type === "usage.limited")).toEqual([
      { type: "usage.limited", resetsAt: 1_790_000_000_000 },
    ]);
    expect(render(events).usageLimit).toEqual({ resetsAt: 1_790_000_000_000 });
  });

  it("reports a gateway's 503 as a provider error, not completed", async () => {
    const { events, turn } = await startTurn("worker");
    emitApiFailure(
      "API Error: 503 upstream connect error or disconnect/reset before headers. This is a server-side issue, usually temporary — try again in a moment.",
      { api_error_status: 503 },
      "server_error",
    );
    await turn;

    expect(errorsOf(events)).toMatchObject([
      { errorClass: "provider_error", retryable: true },
    ]);
    expect(events.some((event) => event.type === "usage.limited")).toBe(false);
  });

  it("does not report a completed turn as failed", async () => {
    const { events, turn } = await startTurn("worker");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: { content: [{ type: "text", text: "Done." }] },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      is_error: false,
      api_error_status: null,
      num_turns: 1,
      result: "Done.",
      terminal_reason: "completed",
    });
    await turn;
    expect(errorsOf(events)).toEqual([]);
  });

  it("shows the CLI's notices as quiet lines and skips transcript-only ones", async () => {
    const { events, turn } = await startTurn("worker");
    emit({
      type: "system",
      subtype: "informational",
      content: "Git Bash wasn't found, so a Stop hook ran in PowerShell.",
      level: "warning",
      uuid: "n1",
      session_id: "sess_1",
    });
    emit({
      type: "system",
      subtype: "informational",
      content: "Only in transcript mode.",
      level: "info",
      uuid: "n2",
      session_id: "sess_1",
    });
    emit({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      scope: "session",
      original_model: "claude-opus-5",
      fallback_model: "claude-sonnet-5",
      request_id: null,
      content: "Opus 5 declined this request, so Sonnet 5 answered instead.",
      uuid: "n3",
      session_id: "sess_1",
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
      is_error: false,
      num_turns: 1,
      result: "",
    });
    await turn;

    expect(events.filter((event) => event.type === "notice")).toEqual([
      {
        type: "notice",
        text: "Git Bash wasn't found, so a Stop hook ran in PowerShell.",
        level: "warning",
      },
      {
        type: "notice",
        text: "Opus 5 declined this request, so Sonnet 5 answered instead.",
        level: "warning",
      },
    ]);
    const quiet = render(events).blocks.filter(
      (block) => block.role === "system",
    );
    expect(quiet.map((block) => block.text)).toEqual([
      "Git Bash wasn't found, so a Stop hook ran in PowerShell.",
      "Opus 5 declined this request, so Sonnet 5 answered instead.",
    ]);
    expect(quiet.every((block) => !block.notice)).toBe(true);
  });
});
