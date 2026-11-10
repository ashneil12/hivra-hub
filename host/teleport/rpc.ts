// The host RPC for a chat move (WP-177). The desktop reaches these through the SSH host connection, the same path
// as every other remote call. Each method maps one call onto HostTeleportStore; argument shapes are checked here.

import type { CanResume, ChatRecord, Holds, MovePayload, Provider, ReceiveReply } from "../../src/features/connections/model/teleport";
import type { HostTeleportStore } from "./store";

const TELEPORT_METHODS = [
  "teleport.read",
  "teleport.freeze",
  "teleport.thaw",
  "teleport.canResume",
  "teleport.receive",
  "teleport.discard",
  "teleport.activate",
  "teleport.release",
  "teleport.holds",
] as const;

export type TeleportMethod = (typeof TELEPORT_METHODS)[number];

export function isTeleportMethod(method: string): method is TeleportMethod {
  return (TELEPORT_METHODS as readonly string[]).includes(method);
}

function text(params: Record<string, unknown>, key: string, label: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error(`Invalid ${label}`);
  return value;
}

function chatId(params: Record<string, unknown>): string {
  const value = text(params, "chatId", "chat id");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error("Invalid chat id");
  return value;
}

function payload(params: Record<string, unknown>): MovePayload {
  const value = params.payload as MovePayload | undefined;
  if (!value || typeof value !== "object" || !value.chat || !value.manifest || value.manifest.format !== "hivra-teleport-v1") {
    throw new Error("Invalid move payload");
  }
  return value;
}

export async function teleportRpc(
  store: HostTeleportStore,
  method: string,
  params: Record<string, unknown>,
): Promise<ChatRecord | boolean | CanResume | ReceiveReply | Holds | { ok: true } | null> {
  if (!isTeleportMethod(method)) throw new Error("Unsupported teleport operation");
  switch (method) {
    case "teleport.read":
      return store.read(chatId(params));
    case "teleport.freeze":
      return store.freeze(chatId(params), text(params, "moveId", "move id"));
    case "teleport.thaw":
      await store.thaw(chatId(params), text(params, "moveId", "move id"));
      return { ok: true };
    case "teleport.canResume":
      return store.canResume(text(params, "provider", "provider") as Provider, text(params, "model", "model") || "", text(params, "effort", "effort") || "");
    case "teleport.receive":
      return store.receive(chatId(params), text(params, "moveId", "move id"), payload(params));
    case "teleport.discard":
      await store.discard(chatId(params), text(params, "moveId", "move id"));
      return { ok: true };
    case "teleport.activate":
      await store.activate(chatId(params), text(params, "moveId", "move id"));
      return { ok: true };
    case "teleport.holds":
      return store.holds(chatId(params), text(params, "moveId", "move id"));
    case "teleport.release":
      await store.release(chatId(params), text(params, "moveId", "move id"), text(params, "to", "destination"));
      return { ok: true };
  }
}
