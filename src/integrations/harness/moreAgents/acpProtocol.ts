import type { ToolPreview } from "../../../features/sessions/model/session";
import { MORE_AGENT_COPY } from "../../../features/providers/model/moreAgents";
import { composeToolTitle, extractShellCommand, extractToolPreview } from "../core/preview";
import type { ApprovalDecision, HarnessEvent } from "../core/types";

/**
 * WP-134: the generic ACP version 1 mapping for More agents. Only the spec's own shapes are read here. No agent id is
 * checked in this file: a quirk one agent needs is a flavor module of its own, never a branch in the generic path.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** What Hivra tells every ACP agent: it does not read or write files or run a terminal for the agent. */
export const GENERIC_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type InitializeOutcome =
  | { ok: true; loadSession: boolean; agentName?: string }
  | { ok: false; message: string };

/** `initialize` must answer protocol version 1. Anything else is not launched as some other CLI. */
export function readInitialize(result: unknown): InitializeOutcome {
  const record = asRecord(result);
  if (record?.protocolVersion !== ACP_PROTOCOL_VERSION) {
    return { ok: false, message: MORE_AGENT_COPY.wrongVersion };
  }
  const capabilities = asRecord(record.agentCapabilities);
  const info = asRecord(record.agentInfo);
  const agentName = stringField(info, "title") ?? stringField(info, "name");
  return {
    ok: true,
    loadSession: capabilities?.loadSession === true,
    ...(agentName ? { agentName } : {}),
  };
}

export function sessionIdFrom(result: unknown): string | undefined {
  return stringField(asRecord(result), "sessionId");
}

/** True when `session/new` named at least one model. */
export function namesModels(result: unknown): boolean {
  const models = asRecord(asRecord(result)?.models);
  const available = models?.availableModels;
  return Array.isArray(available) && available.length > 0;
}

export function promptBlocks(text: string): { type: "text"; text: string }[] {
  return text.trim() ? [{ type: "text", text }] : [];
}

function textFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFrom).join("");
  const record = asRecord(content);
  if (!record) return "";
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "content") return textFrom(record.content);
  return "";
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "content" ? textFrom(record.content) : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
}

function hasLocations(update: Record<string, unknown>): boolean {
  return Array.isArray(update.locations) && update.locations.length > 0;
}

/**
 * Turn one `session/update` into chat events. `previewed` remembers the tool calls that ever carried a preview or a
 * location, so a later bare status update does not replace a real preview with the "no preview" line.
 */
export function eventsFromUpdate(params: unknown, previewed: Set<string>): HarnessEvent[] {
  const update = asRecord(asRecord(params)?.update);
  if (!update) return [];
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = textFrom(update.content);
    return text ? [{ type: "message.delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = textFrom(update.content);
    return text ? [{ type: "reasoning.delta", text }] : [];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const callId = stringField(update, "toolCallId");
    if (!callId) return [];
    const toolKind = stringField(update, "kind");
    const status = stringField(update, "status");
    const preview: ToolPreview | undefined = extractToolPreview(update, update);
    if (preview || hasLocations(update)) previewed.add(callId);
    const rawTitle = stringField(update, "title");
    const title =
      composeToolTitle({
        kind: toolKind,
        title: rawTitle,
        command: extractShellCommand(update.rawInput),
        path: preview?.path,
        query: preview?.query,
        previewKind: preview?.kind,
      }) || rawTitle;
    const text = toolText(update.content);
    const detail = text || (previewed.has(callId) ? undefined : MORE_AGENT_COPY.noPreview);
    const event: HarnessEvent =
      kind === "tool_call"
        ? {
            type: "tool.started",
            callId,
            title: title || "Tool",
            ...(toolKind ? { kind: toolKind } : {}),
            ...(status ? { status } : {}),
            ...(preview ? { preview } : {}),
          }
        : {
            type: "tool.updated",
            callId,
            ...(title ? { title } : {}),
            ...(toolKind ? { kind: toolKind } : {}),
            ...(status ? { status } : {}),
            ...(preview ? { preview } : {}),
          };
    if (!detail) return [event];
    return [event, { type: "tool.updated", callId, detail }];
  }
  return [];
}

export type PermissionAsk = {
  callId?: string;
  title: string;
  kind?: string;
  preview?: ToolPreview;
  options: { optionId: string; kind?: string }[];
};

export function permissionAsk(params: unknown): PermissionAsk {
  const record = asRecord(params);
  const tool = asRecord(record?.toolCall) ?? {};
  const kind = stringField(tool, "kind");
  const preview = extractToolPreview(tool, tool);
  const rawTitle = stringField(tool, "title");
  const title =
    composeToolTitle({
      kind,
      title: rawTitle,
      command: extractShellCommand(tool.rawInput),
      path: preview?.path,
      query: preview?.query,
      previewKind: preview?.kind,
    }) ||
    rawTitle ||
    "Permission";
  const options = (Array.isArray(record?.options) ? record.options : []).flatMap((item) => {
    const option = asRecord(item);
    const optionId = stringField(option, "optionId");
    if (!optionId) return [];
    const optionKind = stringField(option, "kind");
    return [{ optionId, ...(optionKind ? { kind: optionKind } : {}) }];
  });
  const callId = stringField(tool, "toolCallId");
  return {
    title,
    options,
    ...(callId ? { callId } : {}),
    ...(kind ? { kind } : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * The option that matches the person's answer, by the option kinds the spec defines. "Allow" is a one-time allow
 * only: Hivra never turns one tap into a standing rule, so an agent that offers only "always" is answered
 * "cancelled". "Deny" may use either reject. No matching option means "cancelled".
 */
export function permissionOutcome(
  ask: PermissionAsk,
  decision: ApprovalDecision,
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const order = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const option = ask.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}
