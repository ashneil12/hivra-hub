// Which first mate a chat's asks belong to. A first mate's own chats (its main chat, its chat inside a project, the
// further chats started from it) and a coding team's chat with its lead. Never a team room (several first mates read
// one message there), a worker's chat or a plain chat.
import { mateForSession } from "../../../app/hooks/useMemoryCurator";
import { listMonos } from "../../monos/model/mono";

export function askMateFor(sessionId: string): string | undefined {
  const monos = listMonos();
  const own =
    monos.find((mono) => mono.sessionId === sessionId) ??
    monos.find((mono) => !!mono.projectSessions && Object.values(mono.projectSessions).includes(sessionId)) ??
    monos.find((mono) => !!mono.chats?.includes(sessionId));
  return own?.id ?? mateForSession(sessionId);
}
