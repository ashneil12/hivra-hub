// Onboarding import: one past Claude Code or Codex chat as one of the app's own chats.
//
// The chat keeps its words (tool calls and output stay in the tool's own files) and its real times. A Claude chat
// brought into the very folder it ran in keeps its Claude conversation id, so the next message resumes it with
// everything Claude remembers. Any other chat (Codex, or moved into another project's folder) starts its next turn
// with the chat so far, the same brief a chat moved between computers sends (`movedChatPrompt`).

import type { Block, Session } from "../../sessions/model/session";
import { newSession } from "../../sessions/model/session";
import type { Conversation } from "../../historyImport/model/types";
import { SOURCE_TITLE, type ChatSource, type IndexedChat } from "./plan";

/** A chat id the store accepts. The same past chat always gets the same id, so importing twice never doubles it. */
export function importedChatId(source: ChatSource, chat: Pick<IndexedChat, "sessionId" | "path">): string {
  const raw = chat.sessionId || chat.path;
  let token = raw.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (token.length > 80 || !chat.sessionId) token = `${token.slice(0, 40)}-${hash(raw)}`;
  return `imp-${source === "codex" ? "codex" : "claude"}-${token || hash(raw)}`;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A title from the tool's own, else the person's first words. */
export function chatTitle(conversation: Conversation, chat: Pick<IndexedChat, "title">): string {
  const saved = conversation.title.trim() || chat.title?.trim();
  if (saved) return saved.slice(0, 80);
  const first = conversation.messages.find((message) => message.role === "user")?.content ?? "";
  const line = first.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  if (!line) return `${SOURCE_TITLE[conversation.source as ChatSource] ?? "Imported"} chat`;
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

export function userMessages(conversation: Conversation): number {
  return conversation.messages.filter((message) => message.role === "user").length;
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export type ImportedChat = { session: Session; createdAt: number; updatedAt: number };

/** The chat to save, or null when it holds nothing the person said. */
export function toImportedChat(
  conversation: Conversation,
  chat: IndexedChat,
  folder: string,
): ImportedChat | null {
  if (userMessages(conversation) === 0) return null;
  const harness = chat.source === "codex" ? "codex" : "claude";
  const base = newSession(harness, folder);
  const blocks: Block[] = conversation.messages.map((message, index) => ({
    id: `imp-${index + 1}`,
    role: message.role,
    text: message.content,
    ...(message.role === "user" ? { startedAt: message.timestamp } : {}),
  }));
  const times = conversation.messages.map((message) => message.timestamp);
  const createdAt = Math.min(...times, chat.firstMs ?? Number.POSITIVE_INFINITY);
  const updatedAt = Math.max(...times, chat.mtimeMs);
  const resumes =
    chat.source === "claude_code" &&
    !!chat.sessionId &&
    SAFE_ID.test(chat.sessionId) &&
    !!conversation.cwd &&
    norm(conversation.cwd) === norm(folder);
  const session: Session = {
    ...base,
    id: importedChatId(chat.source, chat),
    title: chatTitle(conversation, chat),
    blocks,
    ...(resumes
      ? { providerSessionId: chat.sessionId }
      : { moveBriefOwed: true, movedFrom: SOURCE_TITLE[chat.source] }),
  };
  return { session, createdAt: Number.isFinite(createdAt) ? createdAt : chat.mtimeMs, updatedAt };
}
