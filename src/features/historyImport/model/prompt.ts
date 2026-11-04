// The distillation ask. Every shown message is labelled with the id a citation
// has to use. Secret messages are not passed in; the caller filters them first.

import type { Conversation, TranscriptMessage } from "./types";
import { findSecrets } from "../../portable/model/secrets";

export function sendable(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter((message) => !message.secret && findSecrets(message.content).length === 0);
}

export function batchPrompt(conversation: Conversation, batch: readonly TranscriptMessage[]): string {
  const body = batch
    .map(
      (message) =>
        `[${message.conversationId} #${message.messageId}] ${message.role}\n${message.content}`,
    )
    .join("\n\n");
  return [
    "You are reading one person's past chats. Write a short profile of how they work: preferences and decisions they make more than once.",
    "Plain Markdown. Every line must end with a citation of a conversation and a message you were shown, written like [src: sess-1 #m1].",
    "Use only those ids. A line without a citation is deleted. Do not invent ids. Do not repeat a key, token or password.",
    "",
    `Conversation ${conversation.id}. Project ${conversation.project}.`,
    "",
    body,
  ].join("\n");
}
