// Translated from Raven raven/importer/scanners/hermes.py strip_images and
// hermes_session_to_messages (Apache-2.0; no separate copyright line) and
// Agent Zero _parse_hermes_jsonl (MIT, Copyright (c) 2025 Agent Zero, s.r.o.).
// Licences: vendor/raven-LICENSE, vendor/agent-zero-LICENSE.
//
// Each jsonl line is one session with a messages array (Agent Zero). System
// and reasoning roles are dropped as Raven drops them. The tool role is dropped
// too: Raven keeps it, and the package says to skip tool noise. Timestamps are
// seconds and must be greater than zero, then multiplied by 1000, as Raven does.

import { hasSecretText } from "../../portable/model/secrets";
import type { Conversation, TranscriptMessage } from "./types";
import { jsonLines, projectName, sourceToken, truncateContent } from "./text";

const NON_TEXT = new Set(["image", "image_url", "input_image", "audio", "input_audio"]);
const TEXT_KEYS = ["text", "content"] as const;
const DATA_URI = /data:(?:image|audio)\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g;

function firstText(part: Record<string, unknown>): string {
  for (const key of TEXT_KEYS) {
    const value = part[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Raven's strip_images. A data URI inside a plain string is replaced too, so it cannot become its own batch. */
export function stripImages(content: unknown): string {
  if (typeof content === "string") return content.replace(DATA_URI, "[media x1]");
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  const texts: string[] = [];
  let nonText = 0;
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const rec = part as Record<string, unknown>;
    if (typeof rec.type === "string" && NON_TEXT.has(rec.type)) {
      nonText += 1;
      continue;
    }
    const text = firstText(rec);
    if (text) texts.push(text.replace(DATA_URI, "[media x1]"));
    else nonText += 1;
  }
  if (nonText) texts.push(`[media x${nonText}]`);
  return texts.join("\n\n");
}

function oneSession(row: Record<string, unknown>, fileKey: string, skipped: number): Conversation | null {
  const messages = row.messages;
  if (!Array.isArray(messages)) return null;
  const rawId = typeof row.id === "string" && row.id ? row.id : typeof row.session_id === "string" ? row.session_id : "";
  const id = sourceToken(rawId, sourceToken(fileKey, "chat"));
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const title = typeof row.title === "string" ? row.title : "";
  const kept: TranscriptMessage[] = [];
  let secrets = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const rec = message as Record<string, unknown>;
    const role = rec.role;
    if (role !== "user" && role !== "assistant") continue;
    const ts = rec.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    const full = stripImages(rec.content).trim();
    if (!full) continue;
    const secret = hasSecretText(full);
    kept.push({
      conversationId: id,
      messageId: `m${kept.length + 1}`,
      role,
      content: truncateContent(full),
      timestamp: Math.trunc(ts * 1000),
      secret,
    });
    if (secret) secrets += 1;
  }
  return {
    id,
    sourceKey: `${fileKey}#${id}`,
    source: "hermes",
    project: projectName(cwd, fileKey),
    title,
    messages: kept,
    skippedLines: skipped,
    secrets,
  };
}

/** Every session in a Hermes jsonl file. Empty when nothing parsed. */
export function parseHermes(sourceKey: string, text: string): Conversation[] {
  const { rows, skipped } = jsonLines(text);
  if (rows.length === 0) return [];
  const out: Conversation[] = [];
  let leftovers = skipped;
  for (const row of rows) {
    const session = oneSession(row, sourceKey, 0);
    if (session) out.push(session);
    else leftovers += 1;
  }
  if (out.length > 0) out[0] = { ...out[0], skippedLines: out[0].skippedLines + leftovers };
  return out;
}
