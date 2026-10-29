import type { MonoState } from "./mono";

/**
 * r67 (Alfred's r66 A9): a Mono idle in its own chat but writing a room turn is busy too: its row says where ("In
 * Leadership team") and the folded Monos header names it with the pulsing dot, as for a turn in its own chat. A Mono
 * already working, waiting or failed in its own chat keeps that state.
 */
export function withRoomTurns(
  states: ReadonlyMap<string, MonoState>,
  roomTurns: ReadonlyMap<string, string>,
  roomName: (chatId: string) => string | undefined,
): ReadonlyMap<string, MonoState> {
  if (!roomTurns.size) return states;
  const out = new Map(states);
  for (const [monoId, chatId] of roomTurns) {
    const own = states.get(monoId);
    if (own && own.status !== "idle") continue;
    const name = roomName(chatId);
    out.set(monoId, { status: "working", activity: name ? `In ${name}` : "In a room" });
  }
  return out;
}
