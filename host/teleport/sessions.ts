// The host's session list as a chat moved here lands in it (WP-177, H4). The copy becomes a real host session the desktop
// can open and use: it is saved with the host's own session store, under a project the host keeps for chats moved from a
// Mac, so the desktop's ordinary session sync shows it. It starts a fresh provider session from the saved messages (the
// move carries no provider transcript). Releasing the chat back to the Mac archives the host copy, so it is not run twice.

import { homedir } from "node:os";
import type { Session } from "../../src/features/sessions/model/session";
import type { HostSession } from "../../src/features/connections/model/protocol";
import type { TransferChat } from "../../src/features/connections/model/teleport";
import type { HostStore } from "../store";
import type { HostChatSessions } from "./store";

/** The host project that holds chats moved here from a Mac. */
export const MOVED_PROJECT_NAME = "Moved from a Mac";

/** The saved messages of a copy, checked to be a list of messages before the host saves them. */
function savedMessages(transcript: string): unknown[] {
  const parsed = JSON.parse(transcript) as unknown;
  if (!Array.isArray(parsed)) throw new Error("The copy's messages are not a list, so nothing was opened");
  return parsed;
}

export function hostChatSessions(store: HostStore): HostChatSessions {
  return {
    open(chat: TransferChat, moveId: string): void {
      const project =
        store.projects().find((candidate) => candidate.name === MOVED_PROJECT_NAME) ??
        store.addProject(homedir(), MOVED_PROJECT_NAME);
      const session = {
        id: chat.chatId,
        harness: chat.provider,
        model: chat.model,
        modelSettings: chat.effort ? { effort: chat.effort } : {},
        runtimeMode: "default",
        title: chat.title,
        cwd: project.cwd,
        blocks: savedMessages(chat.transcript),
        queuedMessages: chat.queued.map((text, index) => ({ id: `${chat.chatId}-queued-${index}`, text, attachments: [] })),
      } as unknown as Session;
      let revision = 0;
      try {
        revision = store.session(chat.chatId).revision;
      } catch {
        revision = 0;
      }
      const now = Date.now();
      store.save(
        {
          session,
          projectId: project.id,
          revision: revision + 1,
          status: "idle",
          updatedAt: now,
          createdAt: now,
          archived: false,
          pinned: false,
        } as HostSession,
        { kind: "teleport-open", moveId },
      );
    },
    close(chatId: string): void {
      try {
        store.session(chatId);
      } catch {
        return; // no host copy was ever opened for this chat
      }
      store.updateSession(chatId, { archived: true });
    },
    current(chatId: string): TransferChat | null {
      let value;
      try {
        value = store.session(chatId);
      } catch {
        return null;
      }
      const session = value.session as Session;
      // The saved messages as they stand now: the copy's messages plus every turn the host ran since (drafts excluded).
      return {
        chatId,
        provider: session.harness as TransferChat["provider"],
        providerSessionId: session.providerSessionId ?? "",
        model: session.model,
        effort: session.modelSettings?.effort ?? "",
        title: session.title,
        transcript: JSON.stringify(session.blocks.filter((block) => !block.draft)),
        queued: (session.queuedMessages ?? []).map((message) => message.text),
      };
    },
  };
}
