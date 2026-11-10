// WP-134b. Runs one More agents turn on the desktop path.
// A failure is a sentence and a return, never a thrown success.
// The child is started by registry_agent_spawn (src-tauri/src/harness/registry_agent.rs). This file does not spawn a CLI.

import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { AGENT_NOT_FOUND, NOT_ANSWERING, STOP_SENT, WAITS } from "./registryCopy";
import { COMMAND_BUILTIN, registryAgentIdForSession, type RegistryAgent } from "./registryList";
import {
  registryPermissionOption,
  runRegistryExchange,
  type RegistryDriver,
} from "./registryProtocol";

export const REGISTRY_IDLE_MS = 3 * 60_000;

export type RegistrySpawnInput = {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: { name: string; value: string }[];
  /** Called when the process exits. A turn in progress hears it as a failed request instead. */
  onExit?: () => void;
};

export type RegistrySpawn = (input: RegistrySpawnInput) => Promise<RegistryDriver>;

type Clock = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
};

const defaultClock: Clock = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let clock: Clock = defaultClock;

export function configureRegistryClock(next?: Clock): void {
  clock = next ?? defaultClock;
}

type Live = {
  driver: RegistryDriver | null;
  generation: number;
  onEvent: (event: HarnessEvent) => void;
  providerSessionId?: string;
  ready: boolean;
  turn: boolean;
  spawning: boolean;
  idle?: unknown;
};

const lives = new Map<string, Live>();
const pending = new Map<string, Map<number, string[]>>();

export function resetRegistryRuntimeForTests(): void {
  for (const id of [...lives.keys()]) releaseRegistrySession(id);
  pending.clear();
  clock = defaultClock;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function spawnSentence(error: unknown): { sentence: string; retryable: boolean } {
  const text = errorText(error);
  if (text.includes("registry-builtin")) return { sentence: COMMAND_BUILTIN, retryable: false };
  // registry-not-found is what registry_agent_spawn says. The others are an OS error passed through. A bare
  // "not found" is not enough: Tauri says it when the command itself is missing, and that is not the person's command.
  if (
    text.includes("registry-not-found") ||
    text.includes("ENOENT") ||
    text.includes("No such file") ||
    text.includes("os error 2")
  ) {
    return { sentence: AGENT_NOT_FOUND, retryable: true };
  }
  return { sentence: NOT_ANSWERING, retryable: true };
}

function isRegistryChat(sessionId: string): boolean {
  return lives.has(sessionId) || Boolean(registryAgentIdForSession(sessionId));
}

async function defaultSpawn(input: RegistrySpawnInput): Promise<RegistryDriver> {
  const { AcpClient } = await import("../../../integrations/harness/core/acp");
  const { killChild, spawnRegistryChild, unwatchChild, watchChild } = await import(
    "../../../integrations/harness/core/child"
  );
  let note: (method: string, params: unknown) => void = () => undefined;
  let req: (id: number, method: string, params: unknown) => void = () => undefined;
  const acp = new AcpClient(input.sessionId, {
    onNotification: (method, params) => note(method, params),
    onRequest: (id, method, params) => req(id, method, params),
  });
  // Watched before the process starts, so no line and no exit can arrive unheard.
  watchChild(
    input.sessionId,
    (line) => acp.pushLine(line),
    () => {
      acp.close(new Error("closed"));
      input.onExit?.();
    },
  );
  try {
    await spawnRegistryChild(input.sessionId, {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
    });
  } catch (error) {
    acp.close(error instanceof Error ? error : new Error("not started"));
    unwatchChild(input.sessionId);
    throw error;
  }
  return {
    request: (method, params, timeoutMs, options) => acp.request(method, params, timeoutMs, options),
    notify: (method, params) => acp.notify(method, params),
    respond: (id, result) => acp.respond(id, result),
    respondError: (id, error) => acp.respondError(id, error),
    onRequest: (handler) => {
      req = handler;
    },
    onNotification: (handler) => {
      note = handler;
    },
    close: () => {
      acp.close();
      unwatchChild(input.sessionId);
      void killChild(input.sessionId).catch(() => undefined);
    },
  };
}

async function startProcess(
  sessionId: string,
  spawn: RegistrySpawn,
  input: RegistrySpawnInput,
  onEvent: (event: HarnessEvent) => void,
): Promise<Live | null> {
  const created: Live = {
    driver: null,
    generation: 0,
    onEvent,
    ready: false,
    turn: false,
    spawning: true,
  };
  lives.set(sessionId, created);
  try {
    const driver = await spawn({
      ...input,
      // An exit between turns frees the slot, so the next message starts a new process and loads the old session.
      onExit: () => {
        if (lives.get(sessionId) === created && !created.turn) releaseRegistrySession(sessionId);
      },
    });
    if (lives.get(sessionId) !== created) {
      try {
        driver.close();
      } catch {
        // The release already closed what it could.
      }
      return null;
    }
    created.driver = driver;
    created.spawning = false;
    if (created.generation !== 0) return null;
    return created;
  } catch (error) {
    if (lives.get(sessionId) === created) lives.delete(sessionId);
    if (created.generation !== 0) return null;
    const mapped = spawnSentence(error);
    onEvent({ type: "session.error", message: mapped.sentence, retryable: mapped.retryable });
    return null;
  }
}

export async function runRegistryTurn(input: {
  agent: RegistryAgent;
  sessionId: string;
  cwd: string;
  text: string;
  providerSessionId?: string;
  onEvent: (event: HarnessEvent) => void;
  spawn?: RegistrySpawn;
}): Promise<void> {
  let live = lives.get(input.sessionId);
  if (live?.spawning || live?.turn) {
    input.onEvent({ type: "status", text: WAITS });
    return;
  }
  if (!live?.driver) {
    live = await startProcess(
      input.sessionId,
      input.spawn ?? defaultSpawn,
      {
        sessionId: input.sessionId,
        command: input.agent.command,
        args: [...input.agent.args],
        cwd: input.cwd,
        env: input.agent.env.map((item) => ({ name: item.name, value: item.value })),
      },
      input.onEvent,
    ) ?? undefined;
    if (!live?.driver) return;
  }
  if (live.idle != null) {
    clock.cancel(live.idle);
    live.idle = undefined;
  }
  live.onEvent = input.onEvent;
  live.turn = true;
  const generation = live.generation;
  const providerSessionId = input.providerSessionId?.trim() || live.providerSessionId;
  try {
    const result = await runRegistryExchange({
      driver: live.driver,
      cwd: input.cwd,
      text: input.text,
      providerSessionId,
      resume: Boolean(live.ready && providerSessionId),
      isCurrent: () => lives.get(input.sessionId) === live && live.generation === generation,
      emit: (event) => {
        if (lives.get(input.sessionId) !== live || live.generation !== generation) return;
        input.onEvent(event);
      },
      onPermission: (id, optionIds) => {
        const row = pending.get(input.sessionId) ?? new Map();
        row.set(id, optionIds);
        pending.set(input.sessionId, row);
      },
    });
    if (lives.get(input.sessionId) !== live || live.generation !== generation) return;
    if (!result.ok) {
      if (result.sentence !== STOP_SENT) releaseRegistrySession(input.sessionId);
      return;
    }
    live.ready = true;
    live.providerSessionId = result.providerSessionId;
    live.idle = clock.schedule(() => releaseRegistrySession(input.sessionId), REGISTRY_IDLE_MS);
  } finally {
    if (lives.get(input.sessionId) === live) live.turn = false;
  }
}

export function cancelRegistryTurn(sessionId: string): boolean {
  const live = lives.get(sessionId);
  if (!live && !registryAgentIdForSession(sessionId)) return false;
  if (!live) return true;
  live.generation += 1;
  if (live.idle != null) {
    clock.cancel(live.idle);
    live.idle = undefined;
  }
  const providerSessionId = live.providerSessionId;
  if (live.driver) {
    void live.driver.notify("session/cancel", providerSessionId ? { sessionId: providerSessionId } : {}).catch(() => undefined);
  }
  live.onEvent({ type: "session.error", message: STOP_SENT, retryable: false });
  return true;
}

export function respondRegistryApproval(
  sessionId: string,
  requestId: number,
  decision: "allow" | "deny",
): boolean {
  const live = lives.get(sessionId);
  if (!live && !registryAgentIdForSession(sessionId)) return false;
  const options = pending.get(sessionId)?.get(requestId) ?? [];
  if (live?.driver) {
    const optionId = registryPermissionOption(decision, options);
    void live.driver.respond(requestId, { outcome: { outcome: "selected", optionId } }).catch(() => undefined);
  }
  pending.get(sessionId)?.delete(requestId);
  return true;
}

export function releaseRegistrySession(sessionId: string): boolean {
  const live = lives.get(sessionId);
  const linked = Boolean(registryAgentIdForSession(sessionId));
  if (!live) return linked;
  if (live.idle != null) clock.cancel(live.idle);
  lives.delete(sessionId);
  pending.delete(sessionId);
  try {
    live.driver?.close();
  } catch {
    // Closing a dead process is still a release.
  }
  return true;
}

/** Stop or forget: close the process, keep the chat link, and do not touch the placeholder CLI. */
export function stopRegistrySession(sessionId: string): boolean {
  if (!isRegistryChat(sessionId)) return false;
  releaseRegistrySession(sessionId);
  return true;
}
