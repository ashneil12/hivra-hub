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

/** The host as the target or source of a move. Its id is the machine id the person added. */
export function sshMoveEndpoint(machineId: string, call: HostCall): MoveEndpoint {
  return {
    id: machineId,
    read: (chatId) => call("teleport.read", { chatId }) as Promise<ChatRecord | null>,
    freeze: async (chatId, moveId, peer) => (await call("teleport.freeze", { chatId, moveId, peer })) === true,
    thaw: async (chatId, moveId) => {
      await call("teleport.thaw", { chatId, moveId });
    },
    canResume: (provider: Provider, model: string, effort: string) =>
      call("teleport.canResume", { provider, model, effort }) as Promise<CanResume>,
    receive: (chatId, moveId, payload: MovePayload) =>
      call("teleport.receive", { chatId, moveId, payload }) as Promise<ReceiveReply>,
    discard: async (chatId, moveId) => {
      await call("teleport.discard", { chatId, moveId });
    },
    activate: async (chatId, moveId) => {
      await call("teleport.activate", { chatId, moveId });
    },
    release: async (chatId, moveId, to) => {
      await call("teleport.release", { chatId, moveId, to });
    },
    holds: (chatId, moveId) => call("teleport.holds", { chatId, moveId }) as Promise<Holds>,
  };
}
