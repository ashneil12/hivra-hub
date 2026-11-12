// A chat as the learner reads it: what the person said, with a short line of what the agent
// answered. Claude Code, Codex and Hermes files come back from the app as raw lines, so they go
// through the history reader (prose only, no tool output). The other stores come back already
// as "user: ..." lines. The text this returns is the text a quote must be found in.

import { parseTranscript } from "../../historyImport/model/parse";
import type { SourceId } from "../../historyImport/model/types";

const RAW: Record<string, SourceId> = { claude: "claude_code", codex: "codex", hermes: "hermes" };
const USER_LINE = 700;
const AGENT_LINE = 160;

export type ChatText = { text: string; userMessages: number };

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function cut(lines: string[], maxChars: number): string {
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      if (!out) return line.slice(0, maxChars);
      break;
    }
    out += `${line}\n`;
  }
  return out.trimEnd();
}

export function chatText(source: string, id: string, raw: string, maxChars: number): ChatText {
  const kind = RAW[source];
  if (!kind) {
    const lines = raw.split("\n");
    const userMessages = lines.filter((line) => /^user:\s*\S/i.test(line)).length;
    return { text: cut(lines.map((line) => line.trimEnd()).filter(Boolean), maxChars), userMessages };
  }
  const messages = parseTranscript(kind, id, raw)
    .flatMap((conversation) => conversation.messages)
    .filter((message) => !message.secret && message.content.trim());
  const userMessages = messages.filter((message) => message.role === "user").length;
  const full = messages.map((message) =>
    message.role === "user"
      ? `user: ${oneLine(message.content, USER_LINE)}`
      : `assistant: ${oneLine(message.content, AGENT_LINE)}`,
  );
  if (full.join("\n").length <= maxChars) return { text: full.join("\n"), userMessages };
  // Too long: what the person said matters most, so the agent's lines go first.
  const said = full.filter((line) => line.startsWith("user: "));
  return { text: cut(said, maxChars), userMessages };
}
