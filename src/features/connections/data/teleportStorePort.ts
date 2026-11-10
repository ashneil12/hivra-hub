// The desktop's saved chats as the move's port (WP-177): a read and a write go through the same store the sidebar uses.
// Everything a move records is a notice in the chat row (see teleportLocal.ts), so the port needs nothing else.

import { getSession, upsertSession } from "../../sessions/data/sessionStore";
import type { Session } from "../../sessions/model/session";
import type { LocalChatPort } from "../model/teleportLocal";

/**
 * `isBusy` answers from the app's live state: whether a turn is in flight for the chat. The saved row never knows,
 * so without it a running chat would read as idle and a move would not refuse it.
 */
export function sessionStoreChatPort(options: { isBusy?: (chatId: string) => boolean } = {}): LocalChatPort {
  const isBusy = options.isBusy ?? (() => false);
  return {
    get: async (id) => {
      const session = await getSession(id);
      return session ? ({ ...session, busy: isBusy(id) } as Session) : null;
    },
    put: async (session: Session) => {
      await upsertSession(session);
    },
  };
}
