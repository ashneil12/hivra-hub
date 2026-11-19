// A chat brought in from Claude Code or Codex becomes the Chief of Staff's own when the person opens it (Ash, 12 Nov:
// "Chief of Staff could take it over properly"). From then on it is one of the Chief of Staff's chats: its name on the
// tab, its instructions and memory behind the next message. The chat keeps its words, its folder and the tool it ran
// on. Chats nobody opens are only filed under the Chief of Staff (convert.ts, isImportedChatId), so a history of
// thousands never lands in the roster.

import { isImportedChatId } from "./convert";

/** The first mate that takes this chat over on opening it, if any. A chat a first mate already holds is left alone. */
export function importedChatTaker(chatId: string, facts: { owner: string | undefined; chief: string | undefined }): string | undefined {
  if (!isImportedChatId(chatId) || facts.owner) return undefined;
  return facts.chief || undefined;
}
