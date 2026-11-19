// Translated from Raven raven/importer/scanners/claude_code.py _extract_event
// (Apache-2.0) and Agent Zero _parse_claude (MIT, Copyright (c) 2025 Agent
// Zero, s.r.o.). Licences: vendor/raven-LICENSE, vendor/agent-zero-LICENSE.
//
// Meta, compact summaries and API errors are dropped as Raven drops them.
// Sidechains are dropped as Agent Zero drops them: a sidechain is another
// agent's trace, not how this person works. Tool calls and tool results are
// dropped too. Raven keeps them; the package says to skip tool noise, and the
// profile is how the person works, not the tool trace.

import { hasSecretText } from "../../portable/model/secrets";
import type { Conversation, TranscriptMessage } from "./types";
import { jsonLines, parseIsoTsMs, projectName, sourceToken, truncateContent } from "./text";

const SKIP_BLOCK = new Set(["thinking", "redacted_thinking", "tool_use", "tool_result", "toolCall", "tool-call"]);

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    const type = rec.type;
    if (typeof type === "string" && SKIP_BLOCK.has(type)) continue;
    if (type === "text" && typeof rec.text === "string" && rec.text) parts.push(rec.text);
  }
  return parts.join("\n\n");
}

type RawTurn = { role: "user" | "assistant"; content: string; timestamp: number };

function turns(raw: RawTurn[], id: string, whole = false): { messages: TranscriptMessage[]; secrets: number } {
  const messages: TranscriptMessage[] = [];
  let secrets = 0;
  for (const turn of raw) {
    const full = turn.content.trim();
    if (!full) continue;
    const secret = hasSecretText(full);
    messages.push({
      conversationId: id,
      messageId: `m${messages.length + 1}`,
      role: turn.role,
      content: whole ? full : truncateContent(full),
      timestamp: turn.timestamp,
      secret,
    });
    if (secret) secrets += 1;
  }
  return { messages, secrets };
}

/** One Claude Code jsonl file. Null when it has no JSON objects at all. */
/** `whole` keeps every message's full text (bringing a chat into the app); the learner's reads stay cut. */
export function parseClaude(sourceKey: string, text: string, whole = false): Conversation | null {
  const { rows, skipped } = jsonLines(text);
  if (rows.length === 0) return null;
  let sessionId = sourceToken(sourceKey.replace(/\\/g, "/").split("/").pop() ?? "", "chat");
  let cwd = "";
  let title = "";
  const raw: RawTurn[] = [];
  for (const ev of rows) {
    if (ev.isMeta === true || ev.isCompactSummary === true || ev.isApiErrorMessage === true) continue;
    if (ev.isSidechain === true) continue;
    if (ev.type === "custom-title" && typeof ev.customTitle === "string" && ev.customTitle.trim()) {
      title = ev.customTitle.trim();
      if (typeof ev.sessionId === "string" && ev.sessionId) sessionId = sourceToken(ev.sessionId, sessionId);
      continue;
    }
    const msg = ev.message;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const role = (msg as Record<string, unknown>).role;
    if (role !== "user" && role !== "assistant") continue;
    const content = (msg as Record<string, unknown>).content;
    if (content == null) continue;
    const timestamp = parseIsoTsMs(ev.timestamp);
    if (timestamp == null) continue;
    const prose = textFromContent(content).trim();
    if (!prose) continue;
    raw.push({ role, content: prose, timestamp });
    if (typeof ev.sessionId === "string" && ev.sessionId) sessionId = sourceToken(ev.sessionId, sessionId);
    if (typeof ev.cwd === "string" && ev.cwd) cwd = ev.cwd;
  }
  const id = sessionId;
  const built = turns(raw, id, whole);
  return {
    id,
    sourceKey,
    source: "claude_code",
    project: projectName(cwd, sourceKey),
    ...(cwd ? { cwd } : {}),
    title,
    messages: built.messages,
    skippedLines: skipped,
    secrets: built.secrets,
  };
}
