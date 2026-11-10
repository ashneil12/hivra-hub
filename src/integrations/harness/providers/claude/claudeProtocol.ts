import { isCliNotice } from "../../core/cliNotices";
import { CREDENTIAL_DENY_RULES } from "../../core/credentialGuard";
import type {
  ApprovalCall,
  Attachment,
  RuntimeMode,
  TaskListItem,
  ToolPreview,
  TurnMetrics,
} from "../../../../features/sessions/model/session";
import {
  attachmentPathText,
  promptText,
} from "../../../../features/sessions/model/attachments";
import { parseResetTimestamp } from "../../../../features/providers/model/rateLimits";
import {
  isTaskListToolName,
  normalizeTaskListStatus,
  taskListFromToolInput,
} from "../../../../features/sessions/model/taskList";
import {
  questionPromptTitle,
  questionsFromUnknown,
  selectedAnswerLabels,
  type UserQuestionReply,
} from "../../../../features/sessions/model/userQuestion";
import {
  extractToolPreview,
  isAgentToolName,
  titleFromToolInput,
} from "../../core/preview";
import { streamTextDelta } from "../../core/streamText";
import type { ApprovalDecision, HarnessEvent } from "../../core/types";
import {
  claudeFailureFromResult,
  type ClaudeFailure,
  type ClaudeFailureContext,
} from "./claudeFailure";
import { claudeBridgeKind } from "./claudeDeepseekBridge";
import { bridgeLaunchModel } from "../../../../features/sessions/model/deepseekBridge";

/** Claude Code versions that first ship Opus 5.5 / Opus 5 / Sonnet 5 / Fable 5 / Opus 4.8 / 4.7. */
export const MINIMUM_CLAUDE_OPUS_5_5_VERSION = "2.1.280";
export const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";
export const MINIMUM_CLAUDE_SONNET_5_VERSION = "2.1.197";
export const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
/**
 * Fable 5.1, offline fallback only (live `list_models` is not filtered by it).
 * The CLI's own words for it, in the recorded list_models row in
 * claudeProtocol.test.ts: "Update to 2.1.255+ to use Fable 5.1". Fable 5.2 has
 * no minimum on record anywhere in this checkout, so it has no constant: the
 * fallback offers it wherever it offers 5.1, and live `list_models` decides.
 */
export const MINIMUM_CLAUDE_FABLE_5_1_VERSION = "2.1.255";
export const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
export const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

export const CLAUDE_SETTING_SOURCES = "user,project,local";

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ClaudePermissionMode =
  "default" | "plan" | "acceptEdits" | "auto" | "bypassPermissions";

export type ClaudeControlRequest = {
  requestId: string;
  subtype: string;
  toolName?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
};

export type ClaudeMappedLine = {
  events: HarnessEvent[];
  sessionId?: string;
  control?: ClaudeControlRequest;
  cancelRequestId?: string;
  turnCompleted?: {
    status: "completed" | "failed" | "interrupted" | "cancelled";
    error?: string;
  };
};

export type ClaudeCliSettings = {
  alwaysThinkingEnabled?: boolean;
  fastMode?: boolean;
  ultracode?: boolean;
  disableAllHooks?: boolean;
  /** r83 (quietWorkers.ts): Claude Code's own phone pushes and done/needs-input pings, off for hub workers. */
  agentPushNotifEnabled?: boolean;
  inputNeededNotifEnabled?: boolean;
  taskCompleteNotifEnabled?: boolean;
  /** Tokens at which Claude Code compacts (100K-1M); it uses the smaller of this and the model window. */
  autoCompactWindow?: number;
  /** Claude Code permission rules; deny rules hold even in bypassPermissions (devCopies.ts uses them). */
  permissions?: { deny?: string[] };
  /** Env for this process only. Flag settings outrank ~/.claude/settings.json, so these win over the user's own. */
  env?: Record<string, string>;
};

/** The sub-agent model variables Claude Code reads (Task sub-agents and dynamic-workflow agents). */
export const SUBAGENT_MODEL_ENV = ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL"] as const;

/**
 * r69 (PM's blind r67, E7): Ash's ~/.claude/settings.json forces Haiku as the sub-agent model (the 28 Oct rule for
 * Haiku test workers on the Anthropic API key). A worker on another provider (the Grok or DeepSeek bridge, or a routed
 * Other model) sent that name to its own gateway, and every sub-agent died with "unknown provider for model
 * claude-haiku-5-5". Off Anthropic, a process's sub-agents run on its own model: `own` is that model, or undefined for
 * an Anthropic worker, whose Haiku rule is left exactly as Ash set it.
 */
export function subagentModelEnv(own: string | undefined): Record<string, string> | undefined {
  const model = own?.trim();
  if (!model) return undefined;
  return Object.fromEntries(SUBAGENT_MODEL_ENV.map((name) => [name, model]));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function stringField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  if (!rec) return undefined;
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseClaudeVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? null;
}

export function compareSemver(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Supervised maps onto a flag like every other mode. Sending nothing left the
 * CLI free to fall back to `permissions.defaultMode` from the user's settings,
 * so a session the picker called Supervised could silently run as `auto`.
 * `default` is the value that asks; `manual` is its alias but needs CLI 2.1.200.
 */
export function runtimeModeToPermission(
  mode: RuntimeMode,
): ClaudePermissionMode {
  switch (mode) {
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** Older model ids that reject `xhigh` and want `max` instead. */
const LEGACY_XHIGH_AS_MAX = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
]);

/**
 * Normalize a resolved Claude effort for `--effort`.
 * `ultracode` pairs with `xhigh`; `ultrathink` is a prompt prefix, not a CLI effort.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") return undefined;
  if (effort === "ultracode") return "xhigh";
  if (effort === "xhigh" && model && LEGACY_XHIGH_AS_MAX.has(model)) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") return "high";
  return effort;
}

export function isClaudeUltracodeEffort(
  effort: string | null | undefined,
): boolean {
  return effort === "ultracode";
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  if (effort !== "ultrathink") return text;
  if (!text) return "Ultrathink:";
  return `Ultrathink:\n${text}`;
}

export function resolveClaudeApiModelId(
  model: string,
  context?: string | null,
): string {
  if (context === "1m") return `${model}[1m]`;
  return model;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function buildClaudeUserMessage(input: {
  text: string;
  attachments?: Attachment[];
  effort?: string | null;
}): Record<string, unknown> {
  const text = applyClaudePromptEffortPrefix(
    promptText(input.text, input.attachments ?? []),
    input.effort,
  );
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: "text", text });
  for (const attachment of input.attachments ?? []) {
    content.push(
      imageContentBlock(attachment) ?? {
        type: "text",
        text: attachmentPathText(attachment),
      },
    );
  }
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content,
    },
  };
}

function imageContentBlock(
  attachment: Attachment,
): Record<string, unknown> | null {
  if (attachment.kind !== "image" || !attachment.data) return null;
  const mime = normalizeImageMime(attachment.mimeType);
  if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(mime)) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mime,
      data: attachment.data,
    },
  };
}

function normalizeImageMime(mime: string): string {
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

/**
 * Hivra WP-10: a first mate never edits the project. Claude Code's deny rules hold in every permission mode (bypass
 * included), so its session starts without the tools that write files. Bash stays (it reads git and runs the app's
 * tools); a write made through it is caught by the checkout check after the turn (src-tauri/src/firstmate/).
 */
export const FIRST_MATE_DENY_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * A side question ("by the way", `/btw`) answers from what the chat already did and may look around the project. The
 * tools it is given are an allowlist (`--tools`): Read, Grep and Glob, and nothing the CLI adds later. A deny list can
 * only name what is known today, and it missed EnterWorktree, which creates a worktree and a branch in the project
 * even in plan mode (with only the deny list, Claude Code 2.1.318 still offered it, WebFetch and about twenty others).
 * The allowlist is what keeps a side question read-only; the plan mode it also runs in is not relied on.
 */
export const SIDE_QUESTION_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Kept behind the allowlist: the file-editing tools and Bash (a shell can write, delete or push) are denied by name as
 * well, and a deny rule holds in every permission mode, so one dropped from the allowlist by mistake is still refused.
 */
export const SIDE_QUESTION_DENY_TOOLS = [...FIRST_MATE_DENY_TOOLS, "Bash"];

export function buildClaudeSpawnArgs(input: {
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  resume?: string;
  sessionId?: string;
  settings?: ClaudeCliSettings;
  includePartialMessages?: boolean;
  maxTurns?: number;
  isolated?: boolean;
  /**
   * Accept a later live switch to bypassPermissions over the control channel.
   * Only for a chat in Full access at launch (claude.ts).
   */
  allowBypass?: boolean;
  /** A routed Other model's id (the hub's loopback router): not Anthropic, so its sub-agents run on it too (r69). */
  routedModel?: string;
  /** Hivra WP-10: a first mate's session, which has no file-editing tools (FIRST_MATE_DENY_TOOLS). */
  firstMate?: boolean;
}): string[] {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
  ];
  if (!input.isolated) {
    args.push("--permission-prompt-tool", "stdio");
  }
  if (input.includePartialMessages !== false) {
    args.push("--include-partial-messages");
  }
  // Isolated spawns are MonoCode's own helper calls (titles, summaries); the
  // user's hooks have no business firing there. Interactive sessions inherit
  // whatever the caller decided so `~/.claude` hooks keep working.
  const settings: ClaudeCliSettings = {
    ...input.settings,
    ...(input.isolated ? { disableAllHooks: true } : {}),
  };
  const bridge = claudeBridgeKind();
  // The DeepSeek gateway rejects thinking disabled. On that launcher, thinking stays
  // on and the effort sets how much; what was "off" asks for low effort instead.
  const thinkingWasOff = bridge ? settings.alwaysThinkingEnabled === false : false;
  if (bridge) settings.alwaysThinkingEnabled = true;
  // On the DeepSeek launcher every process asks for DeepSeek by the launcher's own
  // name, and a model it can't place throws before anything starts.
  const model = bridge ? bridgeLaunchModel(input.model, bridge) : input.model;
  const ownSubagents = subagentModelEnv(bridge ? model : input.routedModel);
  if (ownSubagents) settings.env = { ...settings.env, ...ownSubagents };
  if (input.isolated) {
    args.push("--no-session-persistence");
    args.push("--strict-mcp-config");
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
    args.push("--settings", JSON.stringify(settings));
  } else {
    args.push(`--setting-sources=${CLAUDE_SETTING_SOURCES}`);
    args.push("--settings", JSON.stringify(settings));
  }
  const effort = input.effort ?? (thinkingWasOff ? "low" : undefined);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (input.permissionMode) {
    args.push("--permission-mode", input.permissionMode);
  }
  if (
    input.permissionMode === "bypassPermissions" ||
    (input.allowBypass && !input.isolated)
  ) {
    args.push("--allow-dangerously-skip-permissions");
  }
  // r65 (#13): no Claude process reads a saved password or key, Full access included (deny rules hold in bypass mode).
  args.push(
    "--disallowedTools",
    [...CREDENTIAL_DENY_RULES, ...(input.firstMate ? FIRST_MATE_DENY_TOOLS : [])].join(","),
  );
  if (input.resume) args.push("--resume", input.resume);
  if (input.sessionId) args.push("--session-id", input.sessionId);
  if (input.maxTurns) args.push("--max-turns", String(input.maxTurns));
  return args;
}

export function buildControlRequest(
  requestId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: requestId,
    request,
  };
}

export function buildControlResponse(
  requestId: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  };
}

export type ClaudeControlResponse = {
  requestId: string;
  ok: boolean;
  payload: Record<string, unknown> | null;
  error?: string;
};

export function parseControlResponse(
  rec: Record<string, unknown>,
): ClaudeControlResponse | null {
  if (stringField(rec, "type") !== "control_response") return null;
  const nested = asRecord(rec.response);
  const requestId =
    stringField(nested, "request_id") ?? stringField(rec, "request_id") ?? "";
  if (!requestId) return null;
  const subtype = stringField(nested, "subtype") ?? "";
  if (subtype === "error") {
    return {
      requestId,
      ok: false,
      payload: null,
      error: stringField(nested, "error") ?? "control request failed",
    };
  }
  if (subtype && subtype !== "success") return null;
  return {
    requestId,
    ok: true,
    payload: asRecord(nested?.response) ?? {},
  };
}

/** Rows from a `list_models` control response, or null if this line is something else. */
export function listModelsFromControlResponse(
  rec: Record<string, unknown>,
  requestId: string,
): unknown[] | null {
  const parsed = parseControlResponse(rec);
  if (!parsed || parsed.requestId !== requestId) return null;
  if (!parsed.ok) return [];
  return Array.isArray(parsed.payload?.models) ? parsed.payload.models : [];
}

export function isClaudeInitMessage(rec: Record<string, unknown>): boolean {
  const type = stringField(rec, "type");
  const subtype = stringField(rec, "subtype");
  return type === "system" && (subtype === "init" || subtype === "initialized");
}

export function toClaudePermissionResult(
  decision: ApprovalDecision,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (decision === "allow") {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: "User declined tool execution.",
  };
}

export function parseControlRequest(
  rec: Record<string, unknown>,
): ClaudeControlRequest | null {
  const type = stringField(rec, "type");
  if (type !== "control_request" && type !== "sdk_control_request") {
    return null;
  }
  const nested = asRecord(rec.request);
  const requestId =
    stringField(rec, "request_id") ?? stringField(nested, "request_id") ?? "";
  const subtype =
    stringField(nested, "subtype") ?? stringField(rec, "subtype") ?? "";
  if (!requestId || !subtype) return null;
  const input =
    asRecord(nested?.input) ??
    asRecord(nested?.tool_input) ??
    asRecord(rec.input) ??
    {};
  return {
    requestId,
    subtype,
    toolName: stringField(nested, "tool_name") ?? stringField(rec, "tool_name"),
    input,
    toolUseId:
      stringField(nested, "tool_use_id") ??
      stringField(nested, "toolUseID") ??
      stringField(rec, "tool_use_id"),
  };
}

export function parseControlCancelId(
  rec: Record<string, unknown>,
): string | undefined {
  if (stringField(rec, "type") !== "control_cancel_request") return undefined;
  return (
    stringField(rec, "request_id") ??
    stringField(asRecord(rec.request), "request_id")
  );
}

export function sessionIdFromMessage(
  rec: Record<string, unknown>,
): string | undefined {
  const type = stringField(rec, "type");
  const subtype = stringField(rec, "subtype");
  if (type === "system" && subtype?.startsWith("hook_")) return undefined;
  // Subagents can carry their own session id. Rebinding the parent to it
  // would drop resume for the conversation the user is actually in.
  const parent = rec.parent_tool_use_id;
  if (typeof parent === "string" && parent.length > 0) return undefined;
  return stringField(rec, "session_id");
}

/**
 * Claude Code pings `system/status` for every request lifecycle step
 * ("requesting", "responding", …). Codex and opencode only emit status text for
 * notable events — retries, warnings, compaction — so drop the lifecycle chatter
 * here and keep the transcript comparable across harnesses.
 */
const LIFECYCLE_STATUSES = new Set([
  "requesting",
  "request",
  "responding",
  "response",
  "streaming",
  "thinking",
  "working",
  "running",
  "pending",
  "queued",
  "waiting",
  "in_progress",
  "tool_use",
  "idle",
  "done",
  "completed",
  "status",
  "compact",
]);

export function statusTextFromSystem(
  rec: Record<string, unknown>,
): string | undefined {
  if (stringField(rec, "type") !== "system") return undefined;
  const subtype = stringField(rec, "subtype") ?? "";
  const compact = subtype.startsWith("compact");
  if (subtype !== "status" && !compact) return undefined;
  // Prose lives in `message`; `status` carries the bare lifecycle token.
  const text = (stringField(rec, "message") ?? "").trim();
  const notable =
    text && !LIFECYCLE_STATUSES.has(text.toLowerCase().replace(/[\s.…]+$/, ""));
  if (notable) return isCliNotice(text) ? undefined : text;
  // Compaction is worth one row even when the CLI sends no prose with it.
  return compact ? "Compacted context" : undefined;
}

const NOTICE_SUBTYPES = new Set([
  "informational",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "model_fallback",
]);

/**
 * A line the CLI shows its own user that is not part of the reply: a warning,
 * a hook's note, a model refusing and another answering. The CLI keeps `info`
 * lines to its transcript view, so they stay out of the chat too.
 */
export function noticeFromSystem(rec: Record<string, unknown>): {
  text: string;
  level: "notice" | "suggestion" | "warning";
  key?: string;
} | null {
  if (stringField(rec, "type") !== "system") return null;
  const subtype = stringField(rec, "subtype") ?? "";
  if (!NOTICE_SUBTYPES.has(subtype)) return null;
  const text = stringField(rec, "content")?.trim();
  // r65: the CLI's notices about itself (classifier billing) never become an event at all (cliNotices.ts).
  if (!text || isCliNotice(text)) return null;
  if (subtype !== "informational") return { text, level: "warning" };
  const level = stringField(rec, "level") ?? "notice";
  if (level === "info") return null;
  // Progress lines for one tool call replace each other.
  const toolUseId = stringField(rec, "tool_use_id");
  return {
    text,
    level: level === "warning" || level === "suggestion" ? level : "notice",
    ...(toolUseId ? { key: `notice:${toolUseId}` } : {}),
  };
}

/**
 * How a turn ended. Claude Code reports a failed API request as subtype
 * "success" with `is_error`, so success alone never means completed; see
 * `claudeFailure.ts` for the failure classes.
 */
export function turnStatusFromResult(
  rec: Record<string, unknown>,
  context?: ClaudeFailureContext,
): {
  status: "completed" | "failed" | "interrupted" | "cancelled";
  error?: string;
  failure?: ClaudeFailure;
} {
  const terminal = stringField(rec, "terminal_reason") ?? "";
  // The CLI can label an abort "success"; its terminal reason wins.
  if (terminal === "aborted_tools" || terminal === "aborted_streaming") {
    return { status: "interrupted" };
  }
  if ((stringField(rec, "subtype") ?? "") !== "success") {
    const errors = Array.isArray(rec.errors)
      ? rec.errors.filter((item): item is string => typeof item === "string")
      : [];
    const joined = errors.join(" ").toLowerCase();
    if (joined.includes("interrupt")) return { status: "interrupted" };
    if (joined.includes("cancel")) return { status: "cancelled" };
  }
  const failure = claudeFailureFromResult(rec, context);
  if (!failure) return { status: "completed" };
  return { status: "failed", error: failure.message, failure };
}

/**
 * A `rate_limit_event` that refuses requests, with when its window resets.
 * `null` once requests are allowed again, while extra usage is paying for
 * them and the turn goes on, or when only the extra-usage pool is refused:
 * fast mode bills to it, and Claude Code drops to standard speed and goes on
 * under the plan.
 */
export function usageLimitFromRateLimitEvent(
  rec: Record<string, unknown>,
): { resetsAt?: number } | null {
  const info = asRecord(rec.rate_limit_info);
  if (stringField(info, "status") !== "rejected") return null;
  if (info?.isUsingOverage === true) return null;
  if (stringField(info, "rateLimitType") === "overage") return null;
  const resetsAt = parseResetTimestamp(info?.resetsAt);
  return resetsAt != null ? { resetsAt } : {};
}

export function streamDeltaFromEvent(
  rec: Record<string, unknown>,
): { kind: "assistant" | "reasoning"; text: string } | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") {
    return null;
  }
  const delta = asRecord(event.delta);
  const deltaType = stringField(delta, "type") ?? "";
  if (deltaType === "text_delta") {
    const text = streamTextDelta(delta?.text);
    return text ? { kind: "assistant", text } : null;
  }
  if (deltaType === "thinking_delta") {
    const text = streamTextDelta(delta?.thinking);
    return text ? { kind: "reasoning", text } : null;
  }
  return null;
}

export function toolStartFromEvent(rec: Record<string, unknown>): {
  index: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
} | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_start") {
    return null;
  }
  const block = asRecord(event.content_block);
  if (!block) return null;
  const blockType = stringField(block, "type") ?? "";
  if (
    blockType !== "tool_use" &&
    blockType !== "server_tool_use" &&
    blockType !== "mcp_tool_use"
  ) {
    return null;
  }
  const id = stringField(block, "id");
  const name = stringField(block, "name");
  if (!id || !name) return null;
  const index = typeof event.index === "number" ? event.index : -1;
  return {
    index,
    id,
    name,
    input: asRecord(block.input) ?? {},
  };
}

export function inputJsonDeltaFromEvent(
  rec: Record<string, unknown>,
): { index: number; partial: string } | null {
  const event = asRecord(rec.event);
  if (!event || stringField(event, "type") !== "content_block_delta") {
    return null;
  }
  const delta = asRecord(event.delta);
  if (stringField(delta, "type") !== "input_json_delta") return null;
  const partial =
    typeof delta?.partial_json === "string" ? delta.partial_json : "";
  if (!partial) return null;
  const index = typeof event.index === "number" ? event.index : -1;
  return { index, partial };
}

export function isSubagentMessage(rec: Record<string, unknown>): boolean {
  const parent = rec.parent_tool_use_id;
  return typeof parent === "string" && parent.length > 0;
}

/**
 * On resume, the CLI re-reports every background task the session started
 * that it considers unfinished — even ones already stopped and reported —
 * and answers each with an empty, zero-turn result. That result belongs to
 * no turn, so it must not end the one MonoCode is waiting on.
 */
export function isReplayedTaskNotificationResult(
  rec: Record<string, unknown>,
): boolean {
  return (
    stringField(asRecord(rec.origin), "kind") === "task-notification" &&
    rec.num_turns === 0
  );
}

/** What kind of background work a Claude task is, for the resume note after a restart. */
export function cutWorkKind(
  taskType: string | undefined,
): "subagent" | "shell" | "monitor" | "task" {
  const key = (taskType ?? "").toLowerCase();
  if (isAgentTaskType(key)) return "subagent";
  if (key.includes("monitor")) return "monitor";
  if (key.includes("bash") || key.includes("shell")) return "shell";
  return "task";
}

/**
 * What Claude Code 2.1.302 answers `--resume <id>` with when it has no transcript for that id (deleted, or saved
 * under another folder): a `result` with no turns, `is_error`, and "No conversation found with session ID: <id>" in
 * `errors`, then it exits 1. Recorded in fixtures/claude-cli-2.1.302/no-conversation-found.ndjson. The text, or null.
 * Only an error result's `errors` count: a live conversation's zero-turn success (`/goal`, `/goal clear`) repeats
 * whatever the user wrote in `result`, and that must never drop the conversation.
 */
export function deadConversationFromResult(
  rec: Record<string, unknown>,
): string | null {
  if (stringField(rec, "type") !== "result") return null;
  if (rec.is_error !== true || stringField(rec, "subtype") === "success") return null;
  if (typeof rec.num_turns === "number" && rec.num_turns > 0) return null;
  const errors = Array.isArray(rec.errors) ? rec.errors : [];
  return (
    errors.find(
      (text): text is string => typeof text === "string" && /no conversation found/i.test(text),
    ) ?? null
  );
}

export function isAgentTaskType(taskType: string | undefined): boolean {
  const key = (taskType ?? "").toLowerCase();
  return key === "local_agent" || key === "remote_agent";
}

export type ClaudeAgentTaskStarted = {
  taskId: string;
  toolUseId?: string;
  description: string;
  taskType: string;
  backgrounded: boolean;
  ambient: boolean;
};

export function parseTaskStarted(
  rec: Record<string, unknown>,
): ClaudeAgentTaskStarted | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_started"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    description: stringField(rec, "description") ?? "Subagent",
    taskType: stringField(rec, "task_type") ?? "",
    backgrounded: rec.is_backgrounded === true,
    ambient: rec.ambient === true,
  };
}

export type ClaudeAgentTaskProgress = {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  lastToolName?: string;
  summary?: string;
};

export function parseTaskProgress(
  rec: Record<string, unknown>,
): ClaudeAgentTaskProgress | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_progress"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    description: stringField(rec, "description") ?? "Subagent",
    subagentType: stringField(rec, "subagent_type"),
    lastToolName: stringField(rec, "last_tool_name"),
    summary: stringField(rec, "summary"),
  };
}

export type ClaudeAgentTaskUpdated = {
  taskId: string;
  status?: string;
  description?: string;
  error?: string;
  backgrounded?: boolean;
};

export function parseTaskUpdated(
  rec: Record<string, unknown>,
): ClaudeAgentTaskUpdated | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_updated"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  const patch = asRecord(rec.patch) ?? {};
  if (!taskId) return null;
  const backgrounded =
    patch.is_backgrounded === true
      ? true
      : patch.is_backgrounded === false
        ? false
        : undefined;
  return {
    taskId,
    status: stringField(patch, "status"),
    description: stringField(patch, "description"),
    error: stringField(patch, "error"),
    ...(backgrounded !== undefined ? { backgrounded } : {}),
  };
}

export type ClaudeAgentTaskNotification = {
  taskId: string;
  toolUseId?: string;
  status: string;
  summary: string;
  ambient: boolean;
};

export function parseTaskNotification(
  rec: Record<string, unknown>,
): ClaudeAgentTaskNotification | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "task_notification"
  ) {
    return null;
  }
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: stringField(rec, "tool_use_id"),
    status: stringField(rec, "status") ?? "completed",
    summary: stringField(rec, "summary") ?? "",
    ambient: rec.ambient === true,
  };
}

export type ClaudeBackgroundTask = {
  taskId: string;
  taskType: string;
  description: string;
};

/** Every task Claude is running for the session: subagents, shells, monitors. */
export function parseBackgroundTasks(
  rec: Record<string, unknown>,
): ClaudeBackgroundTask[] | null {
  if (
    stringField(rec, "type") !== "system" ||
    stringField(rec, "subtype") !== "background_tasks_changed"
  ) {
    return null;
  }
  const tasks = Array.isArray(rec.tasks) ? rec.tasks : [];
  return tasks.flatMap((item) => {
    const row = asRecord(item);
    if (!row || row.ambient === true) return [];
    const taskId = stringField(row, "task_id");
    const taskType = stringField(row, "task_type") ?? "";
    if (!taskId) return [];
    return [
      {
        taskId,
        taskType,
        description: stringField(row, "description") ?? "Subagent",
      },
    ];
  });
}

export type ClaudeToolProgress = {
  toolUseId: string;
  parentToolUseId?: string;
  toolName?: string;
  subagentType?: string;
  /** How long the call has run, as Claude Code reports it. */
  elapsedMs?: number;
};

export function parseToolProgress(
  rec: Record<string, unknown>,
): ClaudeToolProgress | null {
  if (stringField(rec, "type") !== "tool_progress") return null;
  const toolUseId = stringField(rec, "tool_use_id");
  if (!toolUseId) return null;
  const parent = stringField(rec, "parent_tool_use_id");
  return {
    toolUseId,
    ...(parent ? { parentToolUseId: parent } : {}),
    toolName: stringField(rec, "tool_name"),
    subagentType: stringField(rec, "subagent_type"),
    ...(typeof rec.elapsed_time_seconds === "number" && Number.isFinite(rec.elapsed_time_seconds)
      ? { elapsedMs: Math.round(rec.elapsed_time_seconds * 1000) }
      : {}),
  };
}

export function isTerminalAgentTaskStatus(status: string | undefined): boolean {
  const key = (status ?? "").toLowerCase();
  return (
    key === "completed" ||
    key === "failed" ||
    key === "killed" ||
    key === "stopped"
  );
}

export function assistantTextBlocks(rec: Record<string, unknown>): string[] {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (stringField(row, "type") !== "text") return [];
    const text = typeof row?.text === "string" ? row.text : "";
    return text ? [text] : [];
  });
}

/** Reasoning a message carries, used to mirror a subagent's thinking. */
export function assistantThinkingBlocks(rec: Record<string, unknown>): string[] {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (stringField(row, "type") !== "thinking") return [];
    const text = typeof row?.thinking === "string" ? row.thinking : "";
    return text ? [text] : [];
  });
}

/** Provider id of an assistant message, for keying steps mirrored from it. */
export function assistantMessageId(
  rec: Record<string, unknown>,
): string | undefined {
  return stringField(asRecord(rec.message), "id");
}

export function assistantToolUses(rec: Record<string, unknown>): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_use") return [];
    const id = stringField(row, "id");
    const name = stringField(row, "name");
    if (!id || !name) return [];
    return [{ id, name, input: asRecord(row.input) ?? {} }];
  });
}

export function toolResultsFromUserMessage(
  rec: Record<string, unknown>,
): Array<{
  toolUseId: string;
  isError: boolean;
  text: string;
}> {
  const message = asRecord(rec.message);
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row || stringField(row, "type") !== "tool_result") return [];
    const toolUseId = stringField(row, "tool_use_id");
    if (!toolUseId) return [];
    const text = toolResultText(row.content);
    return [
      {
        toolUseId,
        isError: row.is_error === true,
        text,
      },
    ];
  });
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      const row = asRecord(block);
      if (
        stringField(row, "type") === "text" &&
        typeof row?.text === "string"
      ) {
        return [row.text];
      }
      return [];
    })
    .join("");
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  const rec = asRecord(value);
  const plan = stringField(rec, "plan");
  return plan;
}

export function extractAskUserQuestionTitle(
  input: Record<string, unknown>,
): string {
  return questionPromptTitle(questionsFromUnknown(input)) || "Claude question";
}

export function askUserQuestionAllowInput(
  input: Record<string, unknown>,
  reply?: UserQuestionReply,
): Record<string, unknown> {
  const questions = questionsFromUnknown(input);
  const answers: Record<string, string> = {};
  if (reply?.kind === "answered") {
    for (const question of questions) {
      const labels = selectedAnswerLabels(question, reply);
      if (labels.length === 0) continue;
      answers[question.prompt] = question.multiSelect
        ? labels.join(", ")
        : (labels[0] ?? "");
    }
  }
  return { questions: input.questions, answers };
}

export function tryParseJsonRecord(
  value: string,
): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function taskListFromTodos(
  input: Record<string, unknown>,
): TaskListItem[] | null {
  return taskListFromToolInput("TodoWrite", input);
}

export function isTodoTool(toolName: string): boolean {
  return isTaskListToolName(toolName);
}

/**
 * Newer Claude Code builds replace TodoWrite with incremental task tools:
 * TaskCreate adds one item and TaskUpdate changes one item by id.
 */
export function isClaudeTaskTool(toolName: string): boolean {
  return ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(
    toolName.trim(),
  );
}

/**
 * Fold one successful TaskCreate/TaskUpdate call into the session's task map.
 * Returns true when the visible list changed. TaskCreate only learns its id
 * from the result text ("Task #3 created successfully: ...").
 */
export function applyClaudeTaskTool(
  tasks: Map<string, TaskListItem>,
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
): boolean {
  const name = toolName.trim();
  if (name === "TaskCreate") {
    const text = [input.subject, input.activeForm, input.description]
      .find(
        (value): value is string =>
          typeof value === "string" && !!value.trim(),
      )
      ?.trim();
    const id = resultText.match(/Task #([^\s:]+)/)?.[1];
    if (!text || !id) return false;
    tasks.set(id, { id, text, status: "pending" });
    return true;
  }
  if (name === "TaskUpdate") {
    const rawId = input.taskId;
    const id =
      typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : typeof rawId === "string"
          ? rawId.trim().replace(/^#/, "")
          : "";
    const current = id ? tasks.get(id) : undefined;
    if (!current) return false;
    const status = stringField(input, "status")?.trim().toLowerCase();
    if (status === "deleted") {
      tasks.delete(id);
      return true;
    }
    const subject = stringField(input, "subject")?.trim();
    tasks.set(id, {
      ...current,
      ...(subject ? { text: subject } : {}),
      ...(status ? { status: normalizeTaskListStatus(status) } : {}),
    });
    return true;
  }
  return false;
}

export function toolKindFromName(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (isTodoTool(toolName) || isClaudeTaskTool(toolName)) return "tasks";
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "execute";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("multiedit")
  ) {
    return "edit";
  }
  if (normalized === "read" || normalized.includes("read")) return "read";
  if (
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search") ||
    normalized.includes("websearch")
  ) {
    return "search";
  }
  if (normalized === "skill" || normalized === "skills") return "skill";
  if (normalized === "workflow") return "workflow";
  if (isAgentToolName(toolName)) return "agent";
  return toolName;
}

export function toolTitle(
  name: string,
  input: Record<string, unknown>,
): string {
  return titleFromToolInput(name, toolKindFromName(name), input);
}

export function previewFromTool(
  name: string,
  input: Record<string, unknown>,
  output?: string,
): ToolPreview | undefined {
  const kind = toolKindFromName(name);
  return extractToolPreview(
    {
      title: name,
      name,
      kind,
      input,
      rawInput: input,
      content: output,
    },
    {
      title: name,
      name,
      kind,
      rawInput: input,
    },
  );
}

/** The MCP resource tools (round 2): their arguments are read the way an MCP tool's are. */
const RESOURCE_TOOLS: ReadonlySet<string> = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool"]);

/**
 * What a permission request would run, for policy checks (autopilot): the tool's name, a shell command in full (never
 * cut), and the files an edit or write touches.
 */
export function approvalCall(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalCall {
  const command = typeof input.command === "string" ? input.command : undefined;
  // A search names where it starts in `path` (Grep, Glob, LS), and a Glob also names it in `pattern` (review H1).
  const keys = toolName === "Glob" ? ["file_path", "notebook_path", "path", "pattern"] : ["file_path", "notebook_path", "path"];
  const paths = keys.map((key) => input[key]).filter((value): value is string => typeof value === "string");
  const server = typeof input.server === "string" ? input.server : undefined;
  // A Grep's glob matches files by name, hidden ones too (ripgrep's --glob overrides its ignore rules). It is kept
  // whenever it is given, even when it isn't text, so the search is held rather than read as a plain search (round 2).
  const glob = toolName === "Grep" && input.glob !== undefined ? (typeof input.glob === "string" ? input.glob : "") : undefined;
  // An MCP call's arguments are read by autopilot for paths, addresses and red-list words (review M1). A resource read's
  // uri is one of those arguments too (round 2), so the resource tools are read the same way.
  const args = toolName.startsWith("mcp__") || RESOURCE_TOOLS.has(toolName) ? textLeaves(input) : undefined;
  return {
    tool: toolName,
    ...(command !== undefined ? { command } : {}),
    ...(paths.length ? { paths } : {}),
    ...(server !== undefined ? { server } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(glob !== undefined ? { glob } : {}),
  };
}

/**
 * Every text value and key in a request's arguments, however deep. Past the depth or the count it stops, and says so
 * with a "/" so the check holds rather than reads a cut-off argument as harmless.
 */
function textLeaves(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 200 || depth > 6) {
    out.push("/");
    return out;
  }
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) textLeaves(item, depth + 1, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      textLeaves(item, depth + 1, out);
    }
  return out;
}

export function summarizeToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  if (command) return `${toolName}: ${command.slice(0, 400)}`;
  const description = stringField(input, "description");
  if (description) return description;
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= 400) return `${toolName}: ${serialized}`;
    return `${toolName}: ${serialized.slice(0, 397)}...`;
  } catch {
    return toolName;
  }
}

function numberField(
  rec: Record<string, unknown> | null | undefined,
  key: string,
): number {
  const value = rec?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Tokens occupying the window for one request.
 *
 * Cached reads still take up window space, so they count the same as fresh
 * input; output counts because it carries into the next request.
 */
function contextUsedFromUsage(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  return (
    numberField(usage, "input_tokens") +
    numberField(usage, "cache_creation_input_tokens") +
    numberField(usage, "cache_read_input_tokens") +
    numberField(usage, "output_tokens")
  );
}

/**
 * Aggregate token accounting for the completed Claude turn.
 *
 * The result record also carries `total_cost_usd`, the CLI process's running total (WP-108; the adapter turns it into the turn's own cost). It is kept as reported
 * and never derived: a CLI that doesn't send it gets a turn with tokens and no price.
 */
export function turnMetricsFromResult(
  rec: Record<string, unknown>,
): TurnMetrics | undefined {
  const usage = asRecord(rec.usage);
  const costUsd = reportedCost(rec.total_cost_usd);
  if (!usage) return costUsd == null ? undefined : { costUsd };
  const inputTokens = numberField(usage, "input_tokens");
  const outputTokens = numberField(usage, "output_tokens");
  const cacheReadTokens = numberField(usage, "cache_read_input_tokens");
  const cacheWriteTokens = numberField(usage, "cache_creation_input_tokens");
  const cacheReported =
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage;
  const cacheableInput = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (!inputTokens && !outputTokens && !cacheableInput) {
    return costUsd == null ? undefined : { costUsd };
  }
  return {
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(cacheReported && cacheableInput
      ? { cacheHitPercent: (cacheReadTokens / cacheableInput) * 100 }
      : {}),
    ...(costUsd != null ? { costUsd } : {}),
  };
}

/** A price is money: a finite, non-negative number, or nothing at all. */
function reportedCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Context level from an `assistant` message. Callers must skip subagent
 * messages — subagents run their own window and would make the reading jump.
 */
export function contextUsedFromAssistant(
  rec: Record<string, unknown>,
): number | undefined {
  const usage = asRecord(asRecord(rec.message)?.usage);
  if (!usage) return undefined;
  const used = contextUsedFromUsage(usage);
  return used > 0 ? used : undefined;
}

/**
 * Context level and window from a turn `result`.
 *
 * `usage` at the top level sums every iteration of the turn, so the last entry
 * of `usage.iterations` is what actually sits in the window. `modelUsage`
 * carries the window itself, which is why we let the CLI tell us rather than
 * keeping a model table in sync.
 *
 * With no iterations to read, the top level is only the level when the turn
 * made a single request; `num_turns` says how many it made. Some routes (a
 * gateway in front of a non-Claude model) send `iterations: []` on every turn,
 * where the top level is a whole-turn total — one tool call makes a two-request
 * turn report roughly double what is in the window, so it must NOT be read as
 * the level. The per-`assistant` readings already carried the true figure for
 * that turn; the result then only adds the window.
 */
export function contextFromResult(
  rec: Record<string, unknown>,
): { used?: number; window?: number } | undefined {
  const usage = asRecord(rec.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  const last = asRecord(iterations[iterations.length - 1]);
  const requests = numberField(rec, "num_turns");
  const used =
    last || requests <= 1 ? contextUsedFromUsage(last ?? usage) : 0;

  let window: number | undefined;
  const modelUsage = asRecord(rec.modelUsage);
  for (const entry of Object.values(modelUsage ?? {})) {
    const contextWindow = numberField(asRecord(entry), "contextWindow");
    if (contextWindow > 0) {
      window = Math.max(window ?? 0, contextWindow);
    }
  }

  if (!used && !window) return undefined;
  return { used: used > 0 ? used : undefined, window };
}
