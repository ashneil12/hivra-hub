// The SSH host as the far side of a chat move (WP-177). Each MoveEndpoint call becomes one host RPC over the existing
// host connection (the same route as every remote call, through remoteRequest). The caller passes the call function,
// so the desktop wires it to remoteRequest and the tests wire it to the host's own RPC.

import type {
  CanResume,
  ChatRecord,
  MoveEndpoint,
  MovePayload,
  Provider,
  Holds,
  ReceiveReply,
} from "./teleport";

export type HostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const DEVICE_KEY_STORAGE = "hivra.teleport.device-key";
let memoryDeviceKey = "";

/** Stable across a new bearer token, so re-pairing does not orphan a chat this Mac already holds on the host. */
export function stableDeviceKey(): string {
  if (memoryDeviceKey) return memoryDeviceKey;
  try {
    const saved = globalThis.localStorage?.getItem(DEVICE_KEY_STORAGE) ?? "";
    if (/^[A-Za-z0-9]{16,80}$/.test(saved)) {
      memoryDeviceKey = saved;
      return memoryDeviceKey;
    }
  } catch {
    // Private mode and tests have no storage. The in-memory key still stays for this process.
  }
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? "";
  memoryDeviceKey = uuid.length >= 16 ? uuid : `devicekey${Math.random().toString(36).slice(2)}`;
  try {
    globalThis.localStorage?.setItem(DEVICE_KEY_STORAGE, memoryDeviceKey);
  } catch {
    // The key still lives for this process.
  }
  return memoryDeviceKey;
}

function withDevice(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, deviceKey: stableDeviceKey() };
}

/**
 * The host as the target or source of a move. Its identity is the host's environment id (the host checks a move's
 * destination against it), while the machine id is what the desktop uses to reach the host.
 */
export function sshMoveEndpoint(machineId: string, call: HostCall, environmentId: string = machineId): MoveEndpoint {
  return {
    id: environmentId,
    read: (chatId) => call("teleport.read", withDevice({ chatId })) as Promise<ChatRecord | null>,
    freeze: async (chatId, moveId, peer) => (await call("teleport.freeze", withDevice({ chatId, moveId, peer }))) === true,
    thaw: async (chatId, moveId) => {
      await call("teleport.thaw", withDevice({ chatId, moveId }));
    },
    canResume: (provider: Provider, model: string, effort: string) =>
      call("teleport.canResume", withDevice({ provider, model, effort })) as Promise<CanResume>,
    receive: (chatId, moveId, payload: MovePayload) =>
      call("teleport.receive", withDevice({ chatId, moveId, payload })) as Promise<ReceiveReply>,
    discard: async (chatId, moveId) => {
      await call("teleport.discard", withDevice({ chatId, moveId }));
    },
    abort: async (chatId, moveId) => (await call("teleport.abort", withDevice({ chatId, moveId }))) as "aborted" | "live",
    activate: async (chatId, moveId) => {
      await call("teleport.activate", withDevice({ chatId, moveId }));
    },
    release: async (chatId, moveId, to) => {
      await call("teleport.release", withDevice({ chatId, moveId, to }));
    },
    holds: (chatId, moveId) => call("teleport.holds", withDevice({ chatId, moveId })) as Promise<Holds>,
  };
}
