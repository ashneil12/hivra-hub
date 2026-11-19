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

const hostDeviceKeys = new Map<string, string>();

/**
 * One device key per host, derived from this Mac's stable key and that host's pinned environment id. The desktop's
 * connection id changes when a host is removed and added again, so keying on it orphaned chats already on that host.
 * The same key must not go to every host: whoever runs one host would otherwise own this Mac's moved chats on the others.
 * When the digest cannot be made, nothing is sent: a fallback that still contains the base key would leak it.
 */
async function deviceKeyFor(environmentId: string): Promise<string> {
  const cached = hostDeviceKeys.get(environmentId);
  if (cached) return cached;
  const base = stableDeviceKey();
  let key = "";
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`hivra-device:${base}:${environmentId}`),
    );
    key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new Error("This Mac could not make a device key for that host, so the move was not sent.");
  }
  if (!/^[A-Za-z0-9]{16,80}$/.test(key)) {
    throw new Error("This Mac could not make a device key for that host, so the move was not sent.");
  }
  hostDeviceKeys.set(environmentId, key);
  return key;
}

async function withDevice(environmentId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...params, deviceKey: await deviceKeyFor(environmentId) };
}

/**
 * The host as the target or source of a move. Its identity is the host's environment id (the host checks a move's
 * destination against it), while the machine id is what the desktop uses to reach the host.
 */
export function sshMoveEndpoint(machineId: string, call: HostCall, environmentId: string = machineId): MoveEndpoint {
  return {
    id: environmentId,
    read: async (chatId) => (await call("teleport.read", await withDevice(environmentId, { chatId }))) as ChatRecord | null,
    freeze: async (chatId, moveId, peer) =>
      (await call("teleport.freeze", await withDevice(environmentId, { chatId, moveId, peer }))) === true,
    thaw: async (chatId, moveId) => {
      await call("teleport.thaw", await withDevice(environmentId, { chatId, moveId }));
    },
    canResume: async (provider: Provider, model: string, effort: string) =>
      (await call("teleport.canResume", await withDevice(environmentId, { provider, model, effort }))) as CanResume,
    receive: async (chatId, moveId, payload: MovePayload) =>
      (await call("teleport.receive", await withDevice(environmentId, { chatId, moveId, payload }))) as ReceiveReply,
    discard: async (chatId, moveId) => {
      await call("teleport.discard", await withDevice(environmentId, { chatId, moveId }));
    },
    abort: async (chatId, moveId) =>
      (await call("teleport.abort", await withDevice(environmentId, { chatId, moveId }))) as "aborted" | "live",
    activate: async (chatId, moveId) => {
      await call("teleport.activate", await withDevice(environmentId, { chatId, moveId }));
    },
    release: async (chatId, moveId, to) => {
      await call("teleport.release", await withDevice(environmentId, { chatId, moveId, to }));
    },
    holds: async (chatId, moveId) => (await call("teleport.holds", await withDevice(environmentId, { chatId, moveId }))) as Holds,
  };
}
