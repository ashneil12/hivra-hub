// The host's session list as a chat moved here lands in it (WP-177, H4). The copy becomes a real host session the desktop
// can open and use: it is saved with the host's own session store, under a project the host keeps for chats moved from a
// Mac, so the desktop's ordinary session sync shows it. It starts a fresh provider session from the saved messages (the
// move carries no provider transcript). Releasing the chat back to the Mac archives the host copy, so it is not run twice.

import { homedir } from "node:os";
import { hasPendingApproval, type Session } from "../../src/features/sessions/model/session";
import type { HostSession } from "../../src/features/connections/model/protocol";
import type { TransferChat } from "../../src/features/connections/model/teleport";
import type { HostStore } from "../store";
import { stopHostChat } from "./providerStop";
import { copyBlocks } from "../../src/features/connections/model/teleportLocal";
import type { HostChatSessions } from "./store";

/** The host project that holds chats moved here from a Mac. */
export const MOVED_PROJECT_NAME = "Moved from a Mac";

export function hostChatSessions(store: HostStore): HostChatSessions {
  return {
    open(chat: TransferChat, moveId: string): void {
      try {
        const existing = store.session(chat.chatId);
        // A live session that is not held keeps the turns it has run. A held or archived copy is a leftover
        // from a move that already left, and the new copy replaces it.
        if (!existing.archived && !existing.teleportHeld) return;
      } catch {
        // No host session yet: this arrival creates one.
      }
      // A previous copy of this chat id may still have a warm provider. Stop it before the fresh session starts.
      stopHostChat(chat.chatId);
      const project =
        store.projects().find((candidate) => candidate.name === MOVED_PROJECT_NAME) ??
        store.addProject(homedir(), MOVED_PROJECT_NAME);
      const settings = { ...(chat.modelSettings ?? {}) };
      if (chat.effort && !settings.effort && !settings.reasoningEffort) settings.effort = chat.effort;
      const session = {
        id: chat.chatId,
        harness: chat.provider,
        model: chat.model,
        modelSettings: settings,
        // The first turn's brief names where the chat came from.
        movedFrom: "a Mac",
        runtimeMode: "default",
        title: chat.title,
        // The host account's home directory: that is where this process runs, not the Mac's project folder.
        cwd: project.cwd,
        blocks: copyBlocks(chat.transcript),
        // The first turn here carries the chat so far to the CLI (movedChatPrompt), since the copy has no provider session.
        moveBriefOwed: true,
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
      // Stop before the archive, so a later move out cannot resume this process.
      stopHostChat(chatId);
      try {
        store.session(chatId);
      } catch {
        return; // no host copy was ever opened for this chat
      }
      store.updateSession(chatId, { archived: true });
    },
    activity(chatId: string): { turnRunning: boolean; approvalPending: boolean } | null {
      let value: HostSession;
      try {
        value = store.session(chatId);
      } catch {
        return null;
      }
      const session = value.session as Session;
      return {
        turnRunning: value.status === "running",
        approvalPending: hasPendingApproval(session.blocks) || session.pendingQuestion != null,
      };
    },
    presence(chatId: string): "none" | "open" | "archived" {
      try {
        return store.session(chatId).archived ? "archived" : "open";
      } catch {
        return "none";
      }
    },
    hold(chatId: string, held: boolean): void {
      let value: HostSession;
      try {
        value = store.session(chatId);
      } catch {
        return;
      }
      store.save(
        { ...value, teleportHeld: held, revision: value.revision + 1, updatedAt: Date.now() },
        { type: "teleport.hold", held },
      );
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
        effort: session.modelSettings?.effort || session.modelSettings?.reasoningEffort || "",
        ...(session.modelSettings && Object.keys(session.modelSettings).length > 0
          ? { modelSettings: { ...session.modelSettings } }
          : {}),
        title: session.title,
        transcript: JSON.stringify(session.blocks.filter((block) => !block.draft)),
        queued: (session.queuedMessages ?? []).map((message) => message.text),
      };
    },
  };
}
