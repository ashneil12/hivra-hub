// WP-124: @model: and @cli: record that the next chat should start on that model or CLI. They do not switch the
// chat that is already open. A file mention (@readme) is left alone.

import { isMarkdownBlockquotePosition } from "./quoteDraft";

export const MENTION_NEW_CHAT = "This mention will start a new chat.";
export const MENTION_UNKNOWN_MODEL = "No model is named that, so the mention was left as text.";
export const MENTION_UNKNOWN_CLI = "No CLI is named that, so the mention was left as text.";
export const MENTION_SAME_MODEL = "This chat is already using that model, so the mention was left as text.";
export const MENTION_SAME_CLI = "This chat is already using that CLI, so the mention was left as text.";

const TRAILING_PUNCTUATION = new Set([",", ";", ":", "!", "?", ")", "]", "}", '"', "'", "."]);

export type MentionIntent = {
  kind: "model" | "cli";
  id: string;
};

export type ModelMentionToken = {
  start: number;
  end: number;
  kind: "model" | "cli";
  query: string;
};

export type MentionJudgement =
  | { action: "none" }
  | { action: "ignore"; note: string }
  | { action: "record"; intent: MentionIntent; note: string };

export type MentionChoice = { id: string; name: string };

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function stripTrailing(id: string): string {
  let end = id.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(id[end - 1]!)) end -= 1;
  return id.slice(0, end);
}

type FoundMention = MentionIntent & { start: number; end: number };

/** The first @model: or @cli: that is not inside a quote. The id keeps its own colons. */
export function firstModelMention(text: string): FoundMention | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    if (index > 0 && !isSpace(text[index - 1]!)) continue;
    if (isMarkdownBlockquotePosition(text, index)) continue;
    let end = index + 1;
    while (end < text.length && !isSpace(text[end]!)) end += 1;
    const body = text.slice(index + 1, end);
    const kind = body.startsWith("model:") ? "model" : body.startsWith("cli:") ? "cli" : null;
    if (!kind) continue;
    const id = stripTrailing(body.slice(kind.length + 1));
    return { kind, id, start: index, end };
  }
  return null;
}

/** The @model or @cli token the caret is inside, and only when it is that trigger. */
export function modelMentionTokenAt(text: string, cursor: number): ModelMentionToken | null {
  const index = Math.max(0, Math.min(cursor, text.length));
  let start = index;
  while (start > 0 && !isSpace(text[start - 1]!)) start -= 1;
  if (text[start] !== "@") return null;
  if (start > 0 && !isSpace(text[start - 1]!)) return null;
  if (isMarkdownBlockquotePosition(text, start)) return null;
  let end = start + 1;
  while (end < text.length && !isSpace(text[end]!)) end += 1;
  const typed = text.slice(start + 1, index);
  const kind = typed === "model" || typed.startsWith("model:") ? "model" : typed === "cli" || typed.startsWith("cli:") ? "cli" : null;
  if (!kind) return null;
  const query = typed.startsWith(`${kind}:`) ? typed.slice(kind.length + 1) : "";
  return { start, end, kind, query };
}

/** Replace the open token with @model:id or @cli:id. The token stays in the text. */
export function insertModelMention(text: string, token: ModelMentionToken, id: string): string {
  const rest = text.slice(token.end);
  const spacer = rest.startsWith(" ") ? "" : " ";
  return `${text.slice(0, token.start)}@${token.kind}:${id}${spacer}${rest}`;
}

export function modelMentionChoices(
  token: ModelMentionToken,
  models: readonly MentionChoice[],
  clis: readonly MentionChoice[],
  limit = 8,
): MentionChoice[] {
  const query = token.query.trim().toLowerCase();
  const source = token.kind === "model" ? models : clis;
  const matched = source.filter(
    (choice) =>
      query.length === 0 ||
      choice.id.toLowerCase().includes(query) ||
      choice.name.toLowerCase().includes(query),
  );
  return matched.slice(0, limit);
}

/** What a send should do with the first mention. The live chat is never switched here. */
export function judgeModelMention(
  text: string,
  current: { model: string; harness: string; knownModels: readonly string[]; knownClis: readonly string[] },
): MentionJudgement {
  const found = firstModelMention(text);
  if (!found) return { action: "none" };
  if (found.kind === "model") {
    if (!found.id || !current.knownModels.includes(found.id)) {
      return { action: "ignore", note: MENTION_UNKNOWN_MODEL };
    }
    if (found.id === current.model) return { action: "ignore", note: MENTION_SAME_MODEL };
    return { action: "record", intent: { kind: "model", id: found.id }, note: MENTION_NEW_CHAT };
  }
  if (!found.id || !current.knownClis.includes(found.id)) {
    return { action: "ignore", note: MENTION_UNKNOWN_CLI };
  }
  if (found.id === current.harness) return { action: "ignore", note: MENTION_SAME_CLI };
  return { action: "record", intent: { kind: "cli", id: found.id }, note: MENTION_NEW_CHAT };
}

/** Remember a mention. The same model or CLI is not stored twice. */
export function recordMentionIntent(log: readonly MentionIntent[], intent: MentionIntent): MentionIntent[] {
  if (log.some((row) => row.kind === intent.kind && row.id === intent.id)) return [...log];
  return [...log, { kind: intent.kind, id: intent.id }];
}
