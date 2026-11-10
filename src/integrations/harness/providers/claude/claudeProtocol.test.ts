import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelNote } from "../../../../features/sessions/model/modelNotes";
import {
  modelsForClaudeVersion,
  modelsFromClaudeListModels,
} from "./claudeCatalog";
import {
  applyClaudePromptEffortPrefix,
  applyClaudeTaskTool,
  askUserQuestionAllowInput,
  buildClaudeSpawnArgs,
  CLAUDE_SETTING_SOURCES,
  buildClaudeUserMessage,
  contextFromResult,
  contextUsedFromAssistant,
  deadConversationFromResult,
  extractExitPlanModePlan,
  isClaudeInitMessage,
  isSubagentMessage,
  isTodoTool,
  listModelsFromControlResponse,
  MINIMUM_CLAUDE_OPUS_5_5_VERSION,
  normalizeClaudeCliEffort,
  parseBackgroundTasks,
  parseClaudeVersion,
  parseControlRequest,
  parseControlResponse,
  parseTaskNotification,
  parseTaskProgress,
  parseTaskStarted,
  parseTaskUpdated,
  parseToolProgress,
  taskListFromTodos,
  resolveClaudeApiModelId,
  runtimeModeToPermission,
  sessionIdFromMessage,
  statusTextFromSystem,
  streamDeltaFromEvent,
  toClaudePermissionResult,
  toolKindFromName,
  toolStartFromEvent,
  toolTitle,
  turnStatusFromResult,
  turnMetricsFromResult,
  usageLimitFromRateLimitEvent,
  isReplayedTaskNotificationResult,
} from "./claudeProtocol";
import { claudeFailureFromResult } from "./claudeFailure";

describe("runtimeModeToPermission", () => {
  it("maps runtime modes onto Claude permission flags", () => {
    expect(runtimeModeToPermission("supervised")).toBe("default");
    expect(runtimeModeToPermission("auto-accept-edits")).toBe("acceptEdits");
    expect(runtimeModeToPermission("auto")).toBe("auto");
    expect(runtimeModeToPermission("full-access")).toBe("bypassPermissions");
  });

  it("sends supervised as a flag so settings cannot lower it", () => {
    const args = buildClaudeSpawnArgs({
      permissionMode: runtimeModeToPermission("supervised"),
      sessionId: "sess-supervised",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "default"]),
    );
  });
});

describe("normalizeClaudeCliEffort", () => {
  it("drops ultrathink and maps ultracode to xhigh", () => {
    expect(
      normalizeClaudeCliEffort("ultrathink", "claude-sonnet-5"),
    ).toBeUndefined();
    expect(normalizeClaudeCliEffort("ultracode", "claude-opus-5")).toBe(
      "xhigh",
    );
  });

  it("maps xhigh to max on older models", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-6")).toBe("max");
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-5")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "sonnet")).toBe("xhigh");
  });

  it("maps max to high on sonnet 4.6", () => {
    expect(normalizeClaudeCliEffort("max", "claude-sonnet-4-6")).toBe("high");
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("prefixes ultrathink on the prompt", () => {
    expect(
      applyClaudePromptEffortPrefix("Investigate the edge cases", "ultrathink"),
    ).toBe("Ultrathink:\nInvestigate the edge cases");
    expect(applyClaudePromptEffortPrefix("hello", "high")).toBe("hello");
  });
});

describe("resolveClaudeApiModelId", () => {
  it("appends [1m] for the 1M context window", () => {
    expect(resolveClaudeApiModelId("claude-opus-5", "1m")).toBe(
      "claude-opus-5[1m]",
    );
    expect(resolveClaudeApiModelId("claude-sonnet-5", "200k")).toBe(
      "claude-sonnet-5",
    );
  });
});

describe("buildClaudeSpawnArgs", () => {
  it("speaks stream-json with stdio permissions like the Agent SDK", () => {
    const args = buildClaudeSpawnArgs({
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "acceptEdits",
      sessionId: "sess-1",
    });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--input-format");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--setting-sources=user,project,local");
    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "claude-sonnet-5",
        "--effort",
        "high",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "acceptEdits"]),
    );
    expect(args).toEqual(expect.arrayContaining(["--session-id", "sess-1"]));
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings).disableAllHooks).toBeUndefined();
  });

  it("only disables hooks for interactive sessions when asked", () => {
    const args = buildClaudeSpawnArgs({ settings: { disableAllHooks: true } });
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings)).toMatchObject({ disableAllHooks: true });
  });

  // Ash, 23 Oct: a dump in a hub chat is triaged like one anywhere else, so no skill is held back there.
  it("holds no skill back in a hub chat, and passes the caller's settings through", () => {
    const args = buildClaudeSpawnArgs({ settings: { disableAllHooks: true } });
    expect(args).toContain(`--setting-sources=${CLAUDE_SETTING_SOURCES}`);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings).toEqual({ disableAllHooks: true });
    const bare = buildClaudeSpawnArgs({});
    expect(JSON.parse(bare[bare.indexOf("--settings") + 1])).toEqual({});
    // The app's own background calls don't load ~/.claude at all.
    const isolated = buildClaudeSpawnArgs({ isolated: true });
    expect(JSON.parse(isolated[isolated.indexOf("--settings") + 1])).toMatchObject({ disableAllHooks: true });
  });

  it("skips permissions and MCP for isolated text sessions", () => {
    const args = buildClaudeSpawnArgs({
      isolated: true,
      maxTurns: 1,
      model: "claude-haiku-4-5",
    });
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "1"]));
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings)).toMatchObject({ disableAllHooks: true });
    expect(args).not.toContain("--permission-prompt-tool");
  });

  it("locks isolated read-only prompts to plan mode", () => {
    const args = buildClaudeSpawnArgs({
      isolated: true,
      permissionMode: "plan",
      maxTurns: 1,
      model: "claude-haiku-4-5",
    });
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "plan", "--max-turns", "1"]),
    );
  });

  it("adds bypass flag for full-access", () => {
    const args = buildClaudeSpawnArgs({
      permissionMode: "bypassPermissions",
    });
    expect(args).toContain("--allow-dangerously-skip-permissions");
  });
});

describe("buildClaudeUserMessage", () => {
  it("embeds vision images as base64 source blocks", () => {
    const message = buildClaudeUserMessage({
      text: "look",
      attachments: [
        {
          id: "a1",
          name: "diagram.png",
          mimeType: "image/png",
          kind: "image",
          size: 4,
          data: "AQIDBA==",
        },
      ],
    });
    const content = (message.message as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "AQIDBA==",
      },
    });
  });
});

describe("control protocol", () => {
  it("parses can_use_tool requests", () => {
    const parsed = parseControlRequest({
      type: "control_request",
      request_id: "req_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
      },
    });
    expect(parsed).toMatchObject({
      requestId: "req_1",
      subtype: "can_use_tool",
      toolName: "Bash",
      input: { command: "ls" },
    });
  });

  it("maps allow/deny onto SDK permission results", () => {
    expect(toClaudePermissionResult("allow", { command: "ls" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(toClaudePermissionResult("deny", {})).toMatchObject({
      behavior: "deny",
    });
  });
});

describe("stream mapping", () => {
  it("reads text and thinking deltas", () => {
    expect(
      streamDeltaFromEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi" },
        },
      }),
    ).toEqual({ kind: "assistant", text: "Hi" });
    expect(
      streamDeltaFromEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      }),
    ).toEqual({ kind: "reasoning", text: "hmm" });
  });

  it("reads tool_use content blocks", () => {
    expect(
      toolStartFromEvent({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
        },
      }),
    ).toEqual({
      index: 1,
      id: "toolu_1",
      name: "Read",
      input: { file_path: "a.ts" },
    });
  });
});

describe("usage limits", () => {
  it("reads a refused window and when it resets", () => {
    expect(
      usageLimitFromRateLimitEvent({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_790_000_000,
          rateLimitType: "five_hour",
        },
      }),
    ).toEqual({ resetsAt: 1_790_000_000_000 });
  });

  it("does not stop the session when only fast mode's extra usage runs out", () => {
    // Out of credits refuses fast mode until the monthly reset, while the plan
    // still serves the session at standard speed.
    expect(
      usageLimitFromRateLimitEvent({
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_793_491_200,
          rateLimitType: "overage",
          overageStatus: "rejected",
          overageDisabledReason: "out_of_credits",
          isUsingOverage: false,
        },
      }),
    ).toBeNull();
  });

  it("ignores allowed windows and extra usage", () => {
    expect(
      usageLimitFromRateLimitEvent({
        rate_limit_info: { status: "allowed_warning", resetsAt: 1 },
      }),
    ).toBeNull();
    expect(
      usageLimitFromRateLimitEvent({
        rate_limit_info: { status: "rejected", isUsingOverage: true },
      }),
    ).toBeNull();
  });

  it("recognizes a limit in an errored result", () => {
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your limit · resets 3am (Europe/Sofia)",
      })?.errorClass,
    ).toBe("usage_limit");
    expect(
      claudeFailureFromResult({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "You've hit your limit",
      }),
    ).toBeNull();
  });
});

describe("turnStatusFromResult", () => {
  it("treats aborted terminals as interrupted", () => {
    expect(
      turnStatusFromResult({
        type: "result",
        subtype: "error_during_execution",
        terminal_reason: "aborted_streaming",
        errors: ["interrupt"],
      }).status,
    ).toBe("interrupted");
    expect(
      turnStatusFromResult({ type: "result", subtype: "success" }).status,
    ).toBe("completed");
  });
});

describe("modelsForClaudeVersion", () => {
  it("hides Opus 5 until 2.1.219", () => {
    const old = modelsForClaudeVersion("2.1.100").map(
      (model) => model.nativeId,
    );
    expect(old).not.toContain("claude-opus-5");
    expect(old).not.toContain("claude-opus-4-8");
    expect(old).toContain("claude-sonnet-4-6");

    const next = modelsForClaudeVersion("2.1.233").map(
      (model) => model.nativeId,
    );
    expect(next).toContain("claude-opus-5");
    expect(next).toContain("claude-fable-5");
    expect(next).toContain("claude-sonnet-5");
    expect(next).not.toContain("claude-opus-5-5");
  });

  it("hides Opus 5.5 until 2.1.280, and rejects a missing version", () => {
    const beforeMinimum = modelsForClaudeVersion("2.1.279").map(
      (model) => model.nativeId,
    );
    expect(beforeMinimum).not.toContain("claude-opus-5-5");
    expect(beforeMinimum).toContain("claude-opus-5");

    const atMinimum = modelsForClaudeVersion("2.1.280").map(
      (model) => model.nativeId,
    );
    expect(atMinimum).toContain("claude-opus-5-5");
    expect(atMinimum).toContain("claude-opus-5");

    const missing = modelsForClaudeVersion(null).map((model) => model.nativeId);
    expect(missing).not.toContain("claude-opus-5-5");
  });

  it("hides Sonnet 5 until 2.1.197, and rejects a missing version", () => {
    const beforeMinimum = modelsForClaudeVersion("2.1.196").map(
      (model) => model.nativeId,
    );
    expect(beforeMinimum).not.toContain("claude-sonnet-5");

    const atMinimum = modelsForClaudeVersion("2.1.197").map(
      (model) => model.nativeId,
    );
    expect(atMinimum).toContain("claude-sonnet-5");

    const missing = modelsForClaudeVersion(null).map((model) => model.nativeId);
    expect(missing).not.toContain("claude-sonnet-5");
  });

  it("offers Fable 5.1 from 2.1.255, the version the CLI itself names for it, and rejects a missing version", () => {
    const before = modelsForClaudeVersion("2.1.254").map(
      (model) => model.nativeId,
    );
    expect(before).not.toContain("claude-fable-5-1");
    expect(before).toContain("claude-fable-5");

    const at = modelsForClaudeVersion("2.1.255");
    expect(at.map((model) => model.nativeId)).toContain("claude-fable-5-1");
    const next = at.find((model) => model.nativeId === "claude-fable-5-1");
    const previous = at.find((model) => model.nativeId === "claude-fable-5");
    expect(next).toMatchObject({
      id: "claude:fable-5-1",
      name: "Claude Fable 5.1",
      nativeId: "claude-fable-5-1",
    });
    expect(next?.settings).toEqual(previous?.settings);

    const missing = modelsForClaudeVersion(null).map((model) => model.nativeId);
    expect(missing).not.toContain("claude-fable-5-1");
  });

  it("gives Fable 5.2 no minimum of its own: it follows Fable 5.1, not the borrowed 2.1.280", () => {
    expect(MINIMUM_CLAUDE_OPUS_5_5_VERSION).toBe("2.1.280");
    const at = (version: string | null) =>
      modelsForClaudeVersion(version).map((model) => model.nativeId);

    expect(at("2.1.254")).not.toContain("claude-fable-5-2");
    for (const version of ["2.1.255", "2.1.279", "2.1.280"]) {
      expect(at(version)).toContain("claude-fable-5-2");
      expect(at(version)).toContain("claude-fable-5-1");
    }
    expect(at(null)).not.toContain("claude-fable-5-2");

    const next = modelsForClaudeVersion("2.1.255").find(
      (model) => model.nativeId === "claude-fable-5-2",
    );
    const previous = modelsForClaudeVersion("2.1.255").find(
      (model) => model.nativeId === "claude-fable-5",
    );
    expect(next).toMatchObject({
      id: "claude:fable-5-2",
      name: "Claude Fable 5.2",
      nativeId: "claude-fable-5-2",
    });
    expect(next?.settings).toEqual(previous?.settings);
  });

  it("lists the Fable rows newest first", () => {
    const fable = modelsForClaudeVersion("2.1.304")
      .filter((model) => model.nativeId?.startsWith("claude-fable"))
      .map((model) => model.nativeId);
    expect(fable).toEqual([
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-fable-5",
    ]);
  });
});

describe("list_models catalog", () => {
  const listed = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "list_1",
      response: {
        models: [
          {
            value: "default",
            resolvedModel: "claude-sonnet-5",
            displayName: "Default (recommended)",
            description: "Sonnet 5 · Efficient for routine tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5",
            displayName: "Sonnet",
            description: "Sonnet 5 · Efficient for routine tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            supportsAdaptiveThinking: true,
          },
          {
            value: "claude-fable-5[1m]",
            resolvedModel: "claude-fable-5",
            displayName: "Fable",
            description: "Fable 5 · Most capable for your hardest tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            value: "opus",
            resolvedModel: "claude-opus-5",
            displayName: "Opus",
            description: "Opus 5 · Best for everyday, complex tasks",
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            supportsFastMode: true,
          },
          {
            value: "haiku",
            resolvedModel: "claude-haiku-4-5-20251001",
            displayName: "Haiku",
            description: "Haiku 4.5 · Fastest for quick answers",
          },
          {
            value: "cc-update-required-1",
            resolvedModel: "cc-update-required-1",
            displayName: "Fable 5.1 (disabled)",
            description: "Update to 2.1.255+ to use Fable 5.1",
            disabled: true,
          },
        ],
      },
    },
  };

  it("reads rows from the matching control response", () => {
    expect(listModelsFromControlResponse(listed, "list_1")).toHaveLength(6);
    expect(listModelsFromControlResponse(listed, "other")).toBeNull();
    expect(
      listModelsFromControlResponse(
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "init_1",
            response: { commands: [], models: [] },
          },
        },
        "list_1",
      ),
    ).toBeNull();
  });

  it("maps the picker catalog and drops default/disabled rows", () => {
    const models = modelsFromClaudeListModels(
      listModelsFromControlResponse(listed, "list_1"),
    );
    expect(models.map((model) => model.nativeId)).toEqual([
      "sonnet",
      "claude-fable-5",
      "opus",
      "haiku",
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "claude:sonnet",
      "claude:fable-5",
      "claude:opus",
      "claude:haiku",
    ]);
    expect(models.map((model) => model.name)).toEqual([
      "Sonnet 5",
      "Fable 5",
      "Opus 5",
      "Haiku 4.5",
    ]);

    const sonnet = models[0];
    expect(
      sonnet?.settings
        ?.find((setting) => setting.id === "effort")
        ?.options.map((option) => option.value),
    ).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
      "ultrathink",
    ]);
    expect(sonnet?.settings?.some((setting) => setting.id === "fast")).toBe(
      false,
    );

    const fable = models[1];
    expect(
      fable?.settings?.find((setting) => setting.id === "context"),
    ).toMatchObject({
      value: "1m",
    });

    const opus = models[2];
    expect(opus?.settings?.some((setting) => setting.id === "fast")).toBe(true);

    const haiku = models[3];
    expect(haiku?.settings).toBeUndefined();
  });

  it("records the concrete model behind live-catalog aliases", () => {
    const models = modelsFromClaudeListModels([
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
      {
        value: "claude-fable-5-1[1m]",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable 5.1",
      },
    ]);

    expect(models.map((model) => model.aliasTarget)).toEqual([
      "claude-opus-5-5",
      undefined,
    ]);
  });

  it("adds resolved versions to generic live-catalog alias labels", () => {
    const models = modelsFromClaudeListModels([
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus (1M context)",
        description: "Most capable for complex tasks",
      },
      {
        value: "fable",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
        description: "Fast and capable",
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        description: "Fastest for quick answers",
      },
      {
        value: "next-family",
        resolvedModel: "claude-next-family-7.2-20300101",
        displayName: "Next Family — recommended",
        description: "A future model family",
      },
    ]);

    expect(models.map((model) => model.name)).toEqual([
      "Opus 5.5 (1M context)",
      "Fable 5.1",
      "Haiku 4.5",
      "Next Family 7.2 — recommended",
    ]);
    expect(models[0]).toMatchObject({
      id: "claude:opus",
      nativeId: "opus",
    });
    expect(
      models[0]?.settings?.find((setting) => setting.id === "context")?.value,
    ).toBe("1m");
  });

  it("launches a versioned short value with the claude- prefix", () => {
    const models = modelsFromClaudeListModels([
      {
        value: "opus-5-5",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus",
      },
    ]);

    expect(models.map((model) => model.nativeId)).toEqual([
      "claude-opus-5-5",
      "opus",
    ]);
    expect(models[0]).toMatchObject({
      id: "claude:opus-5-5",
      nativeId: "claude-opus-5-5",
    });
    expect(models[1]).toMatchObject({
      id: "claude:opus",
      nativeId: "opus",
    });
  });

  it("maps a live Fable 5.2 row without dropping the concrete id", () => {
    const note = "Effort levels may behave differently from Fable 5.1.";
    const models = modelsFromClaudeListModels([
      {
        value: "fable",
        resolvedModel: "claude-fable-5-2",
        displayName: "Fable",
        description: "Fast and capable",
      },
      {
        value: "claude-fable-5-2[1m]",
        resolvedModel: "claude-fable-5-2",
        displayName: "Claude Fable 5.2",
      },
    ]);

    expect(models.map((model) => model.name)).toEqual([
      "Fable 5.2",
      "Claude Fable 5.2",
    ]);
    expect(models[0]).toMatchObject({
      id: "claude:fable",
      nativeId: "fable",
      aliasTarget: "claude-fable-5-2",
    });
    expect(models[1]).toMatchObject({
      id: "claude:fable-5-2",
      nativeId: "claude-fable-5-2",
    });
    expect(
      models[1]?.settings?.find((setting) => setting.id === "context")?.value,
    ).toBe("1m");
    expect(modelNote(models[0]!)).toBe(note);
    expect(modelNote(models[1]!)).toBe(note);
  });

  it("maps a live Fable 5.1 row to its own id, with no Fable 5.2 note", () => {
    const models = modelsFromClaudeListModels([
      {
        value: "claude-fable-5-1[1m]",
        resolvedModel: "claude-fable-5-1",
        displayName: "Claude Fable 5.1",
      },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "claude:fable-5-1",
      nativeId: "claude-fable-5-1",
      name: "Claude Fable 5.1",
    });
    expect(
      models[0]?.settings?.find((setting) => setting.id === "context")?.value,
    ).toBe("1m");
    expect(modelNote(models[0]!)).toBeUndefined();
  });

  it("parses success and error control responses", () => {
    expect(
      parseControlResponse({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "init_1",
          response: { pid: 12 },
        },
      }),
    ).toEqual({
      requestId: "init_1",
      ok: true,
      payload: { pid: 12 },
    });
    expect(
      parseControlResponse({
        type: "control_response",
        response: { subtype: "error", request_id: "list_1", error: "nope" },
      }),
    ).toEqual({
      requestId: "list_1",
      ok: false,
      payload: null,
      error: "nope",
    });
    expect(isClaudeInitMessage({ type: "system", subtype: "init" })).toBe(true);
    expect(isClaudeInitMessage({ type: "assistant", subtype: "init" })).toBe(
      false,
    );
  });
});

describe("helpers", () => {
  it("parses CLI version strings", () => {
    expect(parseClaudeVersion("2.1.233 (Claude Code)")).toBe("2.1.233");
  });

  it("classifies tools and todo plans", () => {
    expect(toolKindFromName("Bash")).toBe("execute");
    expect(toolKindFromName("Skill")).toBe("skill");
    expect(toolKindFromName("Agent")).toBe("agent");
    expect(toolKindFromName("Task")).toBe("agent");
    expect(toolTitle("Agent", { description: "Explore the auth module" })).toBe(
      "Explore the auth module",
    );
    expect(toolTitle("Task", { subagent_type: "explore" })).toBe(
      "Explore subagent",
    );
    expect(toolTitle("Bash", { command: "ls -la src" })).toBe("List src");
    expect(toolTitle("Skill", { skill: "code-review" })).toBe(
      "Skill /code-review",
    );
    expect(isTodoTool("TodoWrite")).toBe(true);
    expect(toolKindFromName("TodoWrite")).toBe("tasks");
    expect(toolKindFromName("TaskCreate")).toBe("tasks");
    expect(toolKindFromName("TaskUpdate")).toBe("tasks");
    expect(toolKindFromName("TaskOutput")).not.toBe("agent");
    expect(
      taskListFromTodos({
        todos: [
          { content: "One", status: "completed" },
          { content: "Two", status: "pending" },
        ],
      }),
    ).toEqual([
      { text: "One", status: "completed" },
      { text: "Two", status: "pending" },
    ]);
    expect(extractExitPlanModePlan({ plan: "# Plan" })).toBe("# Plan");
  });

  it("answers AskUserQuestion with the selected options", () => {
    const input = {
      questions: [
        {
          question: "Which file?",
          options: [{ label: "a.ts" }, { label: "b.ts" }],
        },
      ],
    };
    expect(
      askUserQuestionAllowInput(input, {
        kind: "answered",
        answers: { "Which file?": ["b.ts"] },
      }),
    ).toMatchObject({
      answers: { "Which file?": "b.ts" },
    });
  });

  it("drops request lifecycle status pings", () => {
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "status",
        status: "requesting",
      }),
    ).toBeUndefined();
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "status",
        message: "Responding",
      }),
    ).toBeUndefined();
    expect(
      statusTextFromSystem({ type: "system", subtype: "status" }),
    ).toBeUndefined();
  });

  it("keeps status messages that carry real prose", () => {
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "status",
        message: "Retrying in 3s (rate limited)",
      }),
    ).toBe("Retrying in 3s (rate limited)");
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "compact",
        message: "Compacted context to 40k tokens",
      }),
    ).toBe("Compacted context to 40k tokens");
  });

  it("still marks a compact boundary that carries no prose", () => {
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" },
      }),
    ).toBe("Compacted context");
  });

  it("ignores system messages that are not status or compact", () => {
    expect(
      statusTextFromSystem({
        type: "system",
        subtype: "init",
        message: "ready",
      }),
    ).toBeUndefined();
    expect(
      statusTextFromSystem({ type: "assistant", message: "hello" }),
    ).toBeUndefined();
  });
});

describe("contextUsedFromAssistant", () => {
  it("counts cached reads and writes as window occupancy", () => {
    // Shape captured from `claude --output-format stream-json --verbose`.
    const rec = {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 12941,
          cache_read_input_tokens: 16652,
          output_tokens: 3,
        },
      },
    };
    expect(contextUsedFromAssistant(rec)).toBe(29598);
  });

  it("ignores a message with no usage", () => {
    expect(
      contextUsedFromAssistant({ type: "assistant", message: {} }),
    ).toBeUndefined();
  });
});

describe("contextFromResult", () => {
  it("reads the window the CLI reports rather than a model table", () => {
    const rec = {
      type: "result",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 12941,
        cache_read_input_tokens: 16652,
        output_tokens: 13,
      },
      modelUsage: {
        "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000 },
      },
    };
    expect(contextFromResult(rec)).toEqual({ used: 29608, window: 1000000 });
  });

  it("uses the last iteration, since top-level usage sums the whole turn", () => {
    const rec = {
      type: "result",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 90_000,
        output_tokens: 500,
        iterations: [
          {
            input_tokens: 5,
            cache_read_input_tokens: 20_000,
            output_tokens: 200,
          },
          {
            input_tokens: 5,
            cache_read_input_tokens: 70_000,
            output_tokens: 300,
          },
        ],
      },
      modelUsage: { "claude-opus-5": { contextWindow: 200000 } },
    };
    expect(contextFromResult(rec)).toEqual({ used: 70_305, window: 200000 });
  });

  it("reads the top level when a single-request turn sends no iterations", () => {
    // A native turn carries no `iterations`, and one request makes the top level the level itself.
    const rec = {
      type: "result",
      num_turns: 1,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 12_941,
        cache_read_input_tokens: 16_652,
        output_tokens: 13,
      },
      modelUsage: { "claude-sonnet-5": { contextWindow: 1000000 } },
    };
    expect(contextFromResult(rec)).toEqual({ used: 29608, window: 1000000 });
  });

  it("does not read a whole-turn total as the level when the route sends no iterations", () => {
    // The live "Other models" route sends `iterations: []` on every turn, so the top-level usage is the sum over
    // every request in the turn — roughly double the window occupancy after one tool call. The per-`assistant`
    // readings already carried the true figure; the result must not overwrite it with the sum.
    const rec = {
      type: "result",
      num_turns: 2,
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 120_000,
        output_tokens: 92,
        iterations: [],
      },
      modelUsage: { "deepseek-ai/DeepSeek-V4.1-Flash": { contextWindow: 200000 } },
    };
    expect(contextFromResult(rec)).toEqual({ window: 200000 });
  });

  it("still reads the window when the route sends no usage at all", () => {
    const rec = {
      type: "result",
      usage: { iterations: [] },
      modelUsage: { "some-model": { contextWindow: 1048576 } },
    };
    expect(contextFromResult(rec)).toEqual({ window: 1048576 });
  });

  it("has nothing to report for a turn that never called the API", () => {
    expect(contextFromResult({ type: "result", usage: {} })).toBeUndefined();
    expect(
      contextFromResult({ type: "result", usage: { iterations: [] } }),
    ).toBeUndefined();
  });
});

describe("turnMetricsFromResult", () => {
  it("normalizes aggregate input, output, and cache usage", () => {
    expect(
      turnMetricsFromResult({
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 12_941,
          cache_read_input_tokens: 16_652,
          output_tokens: 13,
        },
      }),
    ).toEqual({
      inputTokens: 2,
      cacheWriteTokens: 12_941,
      cacheReadTokens: 16_652,
      outputTokens: 13,
      cacheHitPercent: (16_652 / (2 + 12_941 + 16_652)) * 100,
    });
  });

  // WP-108: a reported price is kept; none is ever guessed.
  it("keeps the total cost the CLI reported", () => {
    expect(
      turnMetricsFromResult({
        total_cost_usd: 0.0036516,
        usage: { input_tokens: 3, output_tokens: 7 },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 7,
      costUsd: 0.0036516,
    });
  });

  it("reports no cost when the CLI sent none", () => {
    const metrics = turnMetricsFromResult({
      usage: { input_tokens: 3, output_tokens: 7 },
    });
    expect(metrics?.costUsd).toBeUndefined();
    expect("costUsd" in (metrics ?? {})).toBe(false);
  });

  it("ignores a cost it cannot read as a number", () => {
    for (const bad of ["0.01", null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        turnMetricsFromResult({
          total_cost_usd: bad,
          usage: { input_tokens: 3, output_tokens: 7 },
        })?.costUsd,
      ).toBeUndefined();
    }
  });

  it("still reports the cost when the usage counts alone are empty", () => {
    const metrics = turnMetricsFromResult({
      total_cost_usd: 0.5,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(metrics).toEqual({ costUsd: 0.5 });
  });
});

describe("subagent messages", () => {
  it("detects nested agent traffic by parent_tool_use_id", () => {
    expect(isSubagentMessage({ parent_tool_use_id: "toolu_agent" })).toBe(true);
    expect(isSubagentMessage({ parent_tool_use_id: null })).toBe(false);
    expect(isSubagentMessage({ type: "assistant" })).toBe(false);
  });

  it("does not rebind the parent session to a subagent session id", () => {
    expect(
      sessionIdFromMessage({
        type: "assistant",
        session_id: "sub_1",
        parent_tool_use_id: "toolu_agent",
      }),
    ).toBeUndefined();
    expect(
      sessionIdFromMessage({
        type: "assistant",
        session_id: "sess_1",
        parent_tool_use_id: null,
      }),
    ).toBe("sess_1");
  });

  it("parses task lifecycle frames for local agents", () => {
    expect(
      parseTaskStarted({
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        description: "Explore the auth module",
        task_type: "local_agent",
        is_backgrounded: true,
      }),
    ).toEqual({
      taskId: "t1",
      toolUseId: "toolu_agent",
      description: "Explore the auth module",
      taskType: "local_agent",
      backgrounded: true,
      ambient: false,
    });
    expect(
      parseTaskProgress({
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        last_tool_name: "Read",
        description: "Explore the auth module",
      }),
    ).toMatchObject({
      taskId: "t1",
      lastToolName: "Read",
    });
    expect(
      parseTaskUpdated({
        type: "system",
        subtype: "task_updated",
        task_id: "t1",
        patch: { status: "completed" },
      }),
    ).toMatchObject({ taskId: "t1", status: "completed" });
    expect(
      parseTaskNotification({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_agent",
        status: "completed",
        summary: "Found the tokens",
      }),
    ).toMatchObject({
      taskId: "t1",
      status: "completed",
      summary: "Found the tokens",
    });
    expect(
      parseBackgroundTasks({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "t1",
            task_type: "local_agent",
            description: "Explore",
          },
          {
            task_id: "bash_1",
            task_type: "local_bash",
            description: "sleep 10",
          },
          {
            task_id: "watch",
            task_type: "local_agent",
            description: "watcher",
            ambient: true,
          },
        ],
      }),
    ).toEqual([
      { taskId: "t1", taskType: "local_agent", description: "Explore" },
      { taskId: "bash_1", taskType: "local_bash", description: "sleep 10" },
    ]);
    expect(
      parseToolProgress({
        type: "tool_progress",
        tool_use_id: "toolu_agent",
        subagent_type: "explore",
      }),
    ).toMatchObject({
      toolUseId: "toolu_agent",
      subagentType: "explore",
    });
  });
});

describe("applyClaudeTaskTool", () => {
  it("creates from the result id, updates, renames and deletes", () => {
    const tasks = new Map();
    expect(
      applyClaudeTaskTool(
        tasks,
        "TaskCreate",
        { subject: "One" },
        "Task #7 created successfully: One",
      ),
    ).toBe(true);
    expect([...tasks.values()]).toEqual([
      { id: "7", text: "One", status: "pending" },
    ]);
    applyClaudeTaskTool(tasks, "TaskUpdate", { taskId: 7, status: "in_progress" }, "");
    applyClaudeTaskTool(tasks, "TaskUpdate", { taskId: "7", subject: "Uno" }, "");
    expect(tasks.get("7")).toEqual({ id: "7", text: "Uno", status: "in_progress" });
    applyClaudeTaskTool(tasks, "TaskUpdate", { taskId: "7", status: "deleted" }, "");
    expect(tasks.size).toBe(0);
  });

  it("ignores unknown ids, missing result ids and other tools", () => {
    const tasks = new Map();
    expect(applyClaudeTaskTool(tasks, "TaskCreate", { subject: "One" }, "error")).toBe(false);
    expect(applyClaudeTaskTool(tasks, "TaskUpdate", { taskId: "9", status: "completed" }, "")).toBe(false);
    expect(applyClaudeTaskTool(tasks, "TaskList", {}, "#1 [pending] One")).toBe(false);
    expect(tasks.size).toBe(0);
  });
});

describe("isReplayedTaskNotificationResult", () => {
  it("matches only a zero-turn result woken by a task notification", () => {
    const origin = { kind: "task-notification" };
    expect(
      isReplayedTaskNotificationResult({ type: "result", num_turns: 0, origin }),
    ).toBe(true);
    expect(
      isReplayedTaskNotificationResult({ type: "result", num_turns: 1, origin }),
    ).toBe(false);
    expect(
      isReplayedTaskNotificationResult({ type: "result", num_turns: 0 }),
    ).toBe(false);
  });
});

describe("deadConversationFromResult", () => {
  // Claude Code 2.1.302's own lines (fixtures/claude-cli-2.1.302).
  const recorded = (name: string) =>
    readFileSync(new URL(`./fixtures/claude-cli-2.1.302/${name}`, import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((rec) => !("probe" in rec));

  it("reads the recorded refusal of `--resume <unknown id>`", () => {
    const [dead] = recorded("no-conversation-found.ndjson");
    expect(deadConversationFromResult(dead)).toBe(
      "No conversation found with session ID: 3f0d2c1a-0000-4000-8000-00000000dead",
    );
  });

  it("never reads a live conversation's zero-turn success, whatever its text repeats", () => {
    // `/goal` with no argument answers with a zero-turn success that repeats the goal; so does `/goal clear`.
    const status = recorded("goal-block-cap-status.ndjson").filter((rec) => rec.type === "result").at(-1)!;
    expect(status).toMatchObject({ subtype: "success", is_error: false, num_turns: 0 });
    const goal = "the log says no conversation found";
    const said = (status.result as string).replace("some condition that stays unmet", goal);
    expect(said).toContain("no conversation found");
    expect(deadConversationFromResult({ ...status, result: said })).toBeNull();
    expect(deadConversationFromResult({ ...status, result: `Goal cleared: ${goal}` })).toBeNull();
  });

  it("reads only `errors`, and only on an error result", () => {
    const [dead] = recorded("no-conversation-found.ndjson");
    // The same words in `result` of an error result are Claude's own text, not the CLI's refusal.
    expect(
      deadConversationFromResult({ ...dead, errors: [], result: "No conversation found with session ID: x" }),
    ).toBeNull();
    // An error flagged success is not the refusal either.
    expect(deadConversationFromResult({ ...dead, is_error: false })).toBeNull();
    expect(deadConversationFromResult({ ...dead, subtype: "success" })).toBeNull();
  });
});
