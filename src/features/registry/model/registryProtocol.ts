// WP-134b. One generic ACP session. No per-CLI shortcut and no Kind arm.
// A thrown request or a timeout is "Not answering", which can be retried.

import { TURN_IDLE_TIMEOUT_MS } from "../../../integrations/harness/core/jsonRpc";
import { extractToolPreview } from "../../../integrations/harness/core/preview";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import {
  CANNOT_CONTINUE,
  NEVER_ASKS,
  NO_MODELS,
  NO_PREVIEW,
  NOT_ANSWERING,
  STOP_SENT,
  UNKNOWN_ASK,
  UNSUPPORTED_PROTOCOL,
} from "./registryCopy";

const INIT_TIMEOUT_MS = 12_000;
const SESSION_TIMEOUT_MS = 45_000;
// A turn is given up on only after an hour without one line from the agent, never a cap on the turn itself.
const PROMPT_IDLE_MS = TURN_IDLE_TIMEOUT_MS;

export type RegistryDriver = {
  /** `idle`: the timeout is a window of silence from the agent, not a cap on the request. */
  request(method: string, params: unknown, timeoutMs: number, options?: { idle?: boolean }): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  respond(id: number, result: unknown): Promise<void>;
  respondError(id: number, error: { code: number; message: string }): Promise<void>;
  onRequest(handler: (id: number, method: string, params: unknown) => void): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): void;
};

export type RegistryExchangeResult =
  | { ok: true; providerSessionId: string }
  | { ok: false; sentence: string; retryable: boolean };

type Emit = (event: HarnessEvent) => void;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  const row = record(value);
  if (!row) return undefined;
  if (typeof row.text === "string" && row.text) return row.text;
  if (Array.isArray(row.content)) {
    return row.content.map((part) => textOf(part)).filter((part): part is string => !!part).join("");
  }
  return textOf(row.content);
}

export function registryPermissionOption(decision: "allow" | "deny", optionIds: string[]): string {
  const names = decision === "allow"
    ? ["allow-once", "allow_once", "allow-always", "allow_always", "allow"]
    : ["reject-once", "reject_once", "reject-always", "reject_always", "reject", "deny"];
  return names.find((name) => optionIds.includes(name)) ?? names[0];
}

function optionIdsOf(params: unknown): string[] {
  const options = record(params)?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((item) => record(item)?.optionId ?? record(item)?.option_id)
    .filter((id): id is string => typeof id === "string");
}

function toolUpdate(params: unknown): HarnessEvent | null {
  const body = record(record(params)?.update) ?? record(params);
  if (!body) return null;
  const kind = body.sessionUpdate ?? body.session_update;
  if (kind === "agent_message_chunk" || kind === "agent_message") {
    const text = textOf(body.content) ?? textOf(body);
    return text ? { type: "message.delta", text } : null;
  }
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;
  const title = textOf(body.title) ?? textOf(body.name) ?? "Tool";
  const callId = textOf(body.toolCallId) ?? textOf(body.tool_call_id) ?? "tool";
  const preview = extractToolPreview(body, body);
  const locations = body.locations ?? body.location;
  const hasLocations = Array.isArray(locations) && locations.length > 0;
  const hasPreview = Boolean(preview && (preview.path || preview.query || preview.lines?.length || preview.output));
  return {
    type: "tool.updated",
    callId,
    title,
    ...(preview ? { preview } : {}),
    ...(!hasLocations && !hasPreview ? { detail: NO_PREVIEW } : {}),
  };
}

function notAnswering(): RegistryExchangeResult {
  return { ok: false, sentence: NOT_ANSWERING, retryable: true };
}

export async function runRegistryExchange(input: {
  driver: RegistryDriver;
  cwd: string;
  text: string;
  providerSessionId?: string;
  isCurrent: () => boolean;
  emit: Emit;
  /** The process is already initialized and the session is already open. */
  resume?: boolean;
  onPermission?: (requestId: number, optionIds: string[]) => void;
}): Promise<RegistryExchangeResult> {
  const { driver, emit, isCurrent } = input;
  let asked = false;
  driver.onRequest((id, method, params) => {
    if (!isCurrent()) return;
    if (method === "session/request_permission") {
      asked = true;
      const row = record(params);
      const title = textOf(row?.title) ?? "Permission";
      input.onPermission?.(id, optionIdsOf(params));
      emit({ type: "approval.requested", requestId: id, title });
      return;
    }
    emit({ type: "notice", text: UNKNOWN_ASK });
    declineRegistryRequest(driver, id);
  });
  driver.onNotification((method, params) => {
    if (!isCurrent() || method !== "session/update") return;
    const event = toolUpdate(params);
    if (event) emit(event);
  });

  let providerSessionId = input.providerSessionId?.trim() ?? "";
  if (input.resume) {
    if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
    if (!providerSessionId) {
      emit({ type: "session.error", message: CANNOT_CONTINUE, retryable: false });
      return { ok: false, sentence: CANNOT_CONTINUE, retryable: false };
    }
  } else {
    let initialized: unknown;
    try {
      initialized = await driver.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      );
    } catch {
      if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
      emit({ type: "session.error", message: NOT_ANSWERING, retryable: true });
      return notAnswering();
    }
    if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
    const protocolVersion = record(initialized)?.protocolVersion;
    if (protocolVersion !== 1) {
      emit({ type: "session.error", message: UNSUPPORTED_PROTOCOL, retryable: false });
      return { ok: false, sentence: UNSUPPORTED_PROTOCOL, retryable: false };
    }
    const models = record(initialized)?.models;
    if (!Array.isArray(models) || models.length === 0) {
      emit({ type: "notice", text: NO_MODELS });
    }

    if (providerSessionId) {
      try {
        await driver.request(
          "session/load",
          { sessionId: providerSessionId, cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
      } catch {
        if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
        emit({ type: "session.error", message: CANNOT_CONTINUE, retryable: false });
        return { ok: false, sentence: CANNOT_CONTINUE, retryable: false };
      }
    } else {
      let created: unknown;
      try {
        created = await driver.request(
          "session/new",
          { cwd: input.cwd, mcpServers: [] },
          SESSION_TIMEOUT_MS,
        );
      } catch {
        if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
        emit({ type: "session.error", message: NOT_ANSWERING, retryable: true });
        return notAnswering();
      }
      const sessionId = record(created)?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        emit({ type: "session.error", message: UNSUPPORTED_PROTOCOL, retryable: false });
        return { ok: false, sentence: UNSUPPORTED_PROTOCOL, retryable: false };
      }
      providerSessionId = sessionId;
    }
  }
  if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };

  try {
    await driver.request(
      "session/prompt",
      { sessionId: providerSessionId, prompt: [{ type: "text", text: input.text }] },
      PROMPT_IDLE_MS,
      { idle: true },
    );
  } catch {
    if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
    emit({ type: "session.error", message: NOT_ANSWERING, retryable: true });
    return notAnswering();
  }
  if (!isCurrent()) return { ok: false, sentence: STOP_SENT, retryable: false };
  if (!asked) emit({ type: "notice", text: NEVER_ASKS });
  emit({ type: "session.providerBound", providerSessionId });
  return { ok: true, providerSessionId };
}

export function declineRegistryRequest(driver: RegistryDriver, id: number): void {
  void driver.respondError(id, { code: -32601, message: "Method not found" }).catch(() => undefined);
}
