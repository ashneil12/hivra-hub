import { isWall, keyName, type Capability } from "./pageSpec";

/**
 * The only door a bespoke page has to the hub: postMessage to the host, which answers only calls the page declared
 * and Ash approved with Keep and allow. Anything else is refused with a plain error. The page never sees IPC or Tauri.
 */
export type BridgeCall = { id: string; call: string; args?: Record<string, unknown> };
export type BridgeReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
/** What runs an approved call. The backend side lives behind the hub transport; unwired ones say so. */
export type BridgeHandlers = Partial<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;

/** The permission a call needs: "keys.read" with {name} needs keys.read:<name>; anything else needs its own name. */
export function capabilityFor(call: BridgeCall): string {
  if (call.call === "keys.read") return `keys.read:${String(call.args?.name ?? "")}`;
  return call.call;
}

export async function handleBridgeCall(call: BridgeCall, approved: readonly Capability[], handlers: BridgeHandlers): Promise<BridgeReply> {
  const id = typeof call?.id === "string" ? call.id : "";
  if (!call || typeof call.call !== "string") return { id, ok: false, error: "That isn't a page call." };
  const need = capabilityFor(call);
  if (isWall(need) || isWall(call.call)) return { id, ok: false, error: "Pages can't do that: changing Monos and reaching the app directly are never allowed." };
  if (!approved.includes(need as Capability)) {
    const key = keyName(need);
    return { id, ok: false, error: key ? `This page didn't ask to read your ${key} key, so it can't.` : `This page didn't ask for “${call.call}”, so it can't use it.` };
  }
  const run = handlers[call.call];
  if (!run) return { id, ok: false, error: "Not connected yet: the hub can't do this for pages yet." };
  try {
    return { id, ok: true, result: await run(call.args ?? {}) };
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : "That didn't work." };
  }
}
