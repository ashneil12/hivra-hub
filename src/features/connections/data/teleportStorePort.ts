// The desktop's saved chats as the move's port (WP-177): reads and writes go through the same store the sidebar uses.
// A moved chat is saved with only its marker, so its transcript leaves this Mac when the host has it.

import { getSession, upsertSession } from "../../sessions/data/sessionStore";
import type { Session } from "../../sessions/model/session";
import type { LocalChatPort } from "../model/teleportLocal";
import { movedBlocks } from "../model/teleportState";

export function sessionStoreChatPort(): LocalChatPort {
  return {
    get: (id) => getSession(id),
    put: async (session: Session) => {
      await upsertSession(session);
    },
    markMoved: async (id, label, at) => {
      const session = await getSession(id);
      if (!session) return;
      await upsertSession({ ...session, blocks: movedBlocks(label, at) } as Session);
    },
  };
}
