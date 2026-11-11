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

/** A key that still fits the host's device check when the digest is unavailable. It differs per host. */
function fallbackDeviceKey(base: string, machineId: string): string {
  let hash = 2166136261;
  const material = `${base}:${machineId}`;
  for (let i = 0; i < material.length; i += 1) hash = Math.imul(hash ^ material.charCodeAt(i), 16777619);
  const mixed = `${(hash >>> 0).toString(16)}${base}${machineId}`.replace(/[^A-Za-z0-9]/g, "");
  return (mixed.length >= 16 ? mixed : `${mixed}devicekeyfallback`).slice(0, 64);
}

/**
 * One device key per host, derived from this Mac's stable key and that host's id. The same key must not go to
 * every host: whoever runs one host would otherwise own this Mac's moved chats on the others.
 */
async function deviceKeyFor(machineId: string): Promise<string> {
  const cached = hostDeviceKeys.get(machineId);
  if (cached) return cached;
  const base = stableDeviceKey();
  let key = "";
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`hivra-device:${base}:${machineId}`));
    key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    key = fallbackDeviceKey(base, machineId);
  }
  if (!/^[A-Za-z0-9]{16,80}$/.test(key)) key = fallbackDeviceKey(base, machineId);
  hostDeviceKeys.set(machineId, key);
  return key;
}

async function withDevice(machineId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...params, deviceKey: await deviceKeyFor(machineId) };
}

/**
 * The host as the target or source of a move. Its identity is the host's environment id (the host checks a move's
 * destination against it), while the machine id is what the desktop uses to reach the host.
 */
export function sshMoveEndpoint(machineId: string, call: HostCall, environmentId: string = machineId): MoveEndpoint {
  return {
    id: environmentId,
    read: async (chatId) => (await call("teleport.read", await withDevice(machineId, { chatId }))) as ChatRecord | null,
    freeze: async (chatId, moveId, peer) => (await call("teleport.freeze", await withDevice(machineId, { chatId, moveId, peer }))) === true,
    thaw: async (chatId, moveId) => {
      await call("teleport.thaw", await withDevice(machineId, { chatId, moveId }));
    },
    canResume: async (provider: Provider, model: string, effort: string) =>
      (await call("teleport.canResume", await withDevice(machineId, { provider, model, effort }))) as CanResume,
    receive: async (chatId, moveId, payload: MovePayload) =>
      (await call("teleport.receive", await withDevice(machineId, { chatId, moveId, payload }))) as ReceiveReply,
    discard: async (chatId, moveId) => {
      await call("teleport.discard", await withDevice(machineId, { chatId, moveId }));
    },
    abort: async (chatId, moveId) => (await call("teleport.abort", await withDevice(machineId, { chatId, moveId }))) as "aborted" | "live",
    activate: async (chatId, moveId) => {
      await call("teleport.activate", await withDevice(machineId, { chatId, moveId }));
    },
    release: async (chatId, moveId, to) => {
      await call("teleport.release", await withDevice(machineId, { chatId, moveId, to }));
    },
    holds: async (chatId, moveId) => (await call("teleport.holds", await withDevice(machineId, { chatId, moveId }))) as Holds,
  };
}
