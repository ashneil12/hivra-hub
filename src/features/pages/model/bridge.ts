import { isWall, type Capability } from "./pageSpec";

/**
 * The only door a bespoke page has to the hub: postMessage to the host, which answers only calls the page declared
 * and Ash approved with Keep and allow. Anything else is refused with a plain error. The page never sees IPC or Tauri.
 * pageBridgeHost.ts runs it for one framed page (calls, live watches, its taps); this is the permission rule.
 */
export type BridgeCall = { id: string; call: string; args?: Record<string, unknown> };
export type BridgeReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
/** What runs an approved call. The backend side lives behind the hub transport; unwired ones say so. */
export type BridgeHandlers = Partial<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;

export const WALL_REFUSAL = "Hubs can't do that: changing Monos and reaching the app directly are never allowed.";
export const KEYS_REFUSAL = "Hubs can't read your keys: a hub can't reach the network, so a key would do nothing inside one.";

/** A page asked for this but Ash hasn't tapped Allow yet (a ready-made page, or one from a setup file). */
export const WAITING_ALLOW = "This hub is waiting for you to allow it. Tap Allow above the hub to let it show this.";
/** The page never asked for this. No permission ids in the words (r65, PM's r63 run). */
export const NOT_ASKED = "This hub didn't ask to use that, so it can't.";

/**
 * Why this call may not run with what is approved, in plain words; undefined when it may. `asks` is what the page's
 * spec asked for: asked but not approved yet says it's waiting for Allow, never "didn't ask for" (r65).
 */
export function refusal(call: Pick<BridgeCall, "call">, approved: readonly Capability[], asks: readonly Capability[] = []): string | undefined {
  if (call.call === "keys.read" || call.call.startsWith("keys.")) return KEYS_REFUSAL;
  if (isWall(call.call)) return WALL_REFUSAL;
  if (!approved.includes(call.call as Capability)) return asks.includes(call.call as Capability) ? WAITING_ALLOW : NOT_ASKED;
  return undefined;
}

export async function handleBridgeCall(call: BridgeCall, approved: readonly Capability[], handlers: BridgeHandlers): Promise<BridgeReply> {
  const id = typeof call?.id === "string" ? call.id : "";
  if (!call || typeof call.call !== "string") return { id, ok: false, error: "That isn't a hub call." };
  const no = refusal(call, approved);
  if (no) return { id, ok: false, error: no };
  const run = handlers[call.call];
  if (!run) return { id, ok: false, error: "Not connected yet: the app can't do this for hubs yet." };
  try {
    return { id, ok: true, result: await run(call.args ?? {}) };
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : "That didn't work." };
  }
}
