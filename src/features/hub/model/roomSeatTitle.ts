import { listMonos, monoLook } from "../../monos/model/mono";
import { getChat } from "./hubChats";

/**
 * r67 (Alfred's r66 rechecks): the Working tray titled room seats with their raw prompt ("You are frank, in the group
 * chat \"Leadership team\"…"), since a room turn's session is named from its first message. A room seat's session
 * reads as the Mono and the room: "frank · Leadership team".
 */
export function roomSeatTitle(sessionId: string): string | undefined {
  for (const mono of listMonos()) {
    const key = Object.entries(mono.roomSessions ?? {}).find(([, id]) => id === sessionId)?.[0];
    if (!key) continue;
    let chatId: string | undefined;
    try {
      chatId = (JSON.parse(key) as unknown[])[0] as string;
    } catch {
      chatId = undefined;
    }
    const room = chatId ? getChat(chatId)?.name : undefined;
    return `${monoLook(mono).name} · ${room ?? "room"}`;
  }
  return undefined;
}
