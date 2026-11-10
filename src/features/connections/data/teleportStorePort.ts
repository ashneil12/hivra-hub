// The desktop's saved chats as the move's port (WP-177): a read and a write go through the same store the sidebar uses.
// Everything a move records is a notice in the chat row (see teleportLocal.ts), so the port needs nothing else.

import { getSession, upsertSession } from "../../sessions/data/sessionStore";
import type { Session } from "../../sessions/model/session";
import type { LocalChatPort } from "../model/teleportLocal";

export function sessionStoreChatPort(): LocalChatPort {
  return {
    get: (id) => getSession(id),
    put: async (session: Session) => {
      await upsertSession(session);
    },
  };
}
