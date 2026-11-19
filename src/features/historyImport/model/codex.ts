// Translated from Agent Zero plugins/_migrate_agents/helpers/migration.py
// _parse_codex (MIT). Copyright (c) 2025 Agent Zero, s.r.o.
// Licence: src/features/historyImport/vendor/agent-zero-LICENSE.
//
// user_message and agent final_answer are kept. Commentary and function calls
// are dropped: Agent Zero stores them as thoughts and tool events, and the
// package says to skip tool noise. A missing timestamp is dropped rather than
// replaced with "now"; an invented time would cite the wrong moment. Bad JSON
// lines are skipped (Raven), not fatal (Agent Zero), because a local file often
// ends torn.

import { hasSecretText } from "../../portable/model/secrets";
import type { Conversation, TranscriptMessage } from "./types";
import { jsonLines, parseIsoTsMs, projectName, sourceToken, truncateContent } from "./text";

/** One Codex jsonl file. Null when it has no JSON objects at all. */
/**
 * `whole` keeps every message's full text (bringing a chat into the app) and counts an agent message with no phase as
 * an answer, as older Codex builds wrote it. The learner's reads stay as they were.
 */
export function parseCodex(sourceKey: string, text: string, whole = false): Conversation | null {
  const { rows, skipped } = jsonLines(text);
  if (rows.length === 0) return null;
  let id = sourceToken(sourceKey.replace(/\\/g, "/").split("/").pop()?.replace(/\.jsonl$/, "") ?? "", "chat");
  let cwd = "";
  const raw: { role: "user" | "assistant"; content: string; timestamp: number }[] = [];
  for (const row of rows) {
    const payload = row.payload;
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
    if (!body) continue;
    if (row.type === "session_meta") {
      if (typeof body.id === "string" && body.id) id = sourceToken(body.id, id);
      else if (typeof body.session_id === "string" && body.session_id) id = sourceToken(body.session_id, id);
      if (typeof body.cwd === "string" && body.cwd) cwd = body.cwd;
      continue;
    }
    if (row.type !== "event_msg") continue;
    const eventType = body.type;
    const message = body.message;
    if (typeof message !== "string" || !message.trim()) continue;
    if (eventType === "agent_message" && body.phase === "commentary") continue;
    const answer = body.phase === "final_answer" || (whole && body.phase == null);
    const role = eventType === "user_message" ? "user" : eventType === "agent_message" && answer ? "assistant" : null;
    if (!role) continue;
    const timestamp = parseIsoTsMs(row.timestamp);
    if (timestamp == null) continue;
    raw.push({ role, content: message, timestamp });
  }
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
  return {
    id,
    sourceKey,
    source: "codex",
    project: projectName(cwd, sourceKey),
    ...(cwd ? { cwd } : {}),
    title: "",
    messages,
    skippedLines: skipped,
    secrets,
  };
}
