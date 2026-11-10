import type { UsageBlock, UsageSession, UsageTurnMetrics } from "./history";

/**
 * WP-108: turn a usage-row payload into the chats the history can count.
 *
 * The payload is untrusted (it is read from disk). Only the fields the history adds up are copied, and only when
 * they are the right shape. A prompt, a reply, a path stuffed into a count, or a row that is not a chat is left out.
 */

const METRIC_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

function usableNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readBlocks(value: unknown): UsageBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: UsageBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.role !== "user") continue;
    const metricsIn = block.turnMetrics;
    if (!metricsIn || typeof metricsIn !== "object") continue;
    const source = metricsIn as Record<string, unknown>;
    const turnMetrics: UsageTurnMetrics = {};
    let any = false;
    for (const key of METRIC_KEYS) {
      const number = usableNumber(source[key]);
      if (number == null) continue;
      turnMetrics[key] = number;
      any = true;
    }
    if (!any) continue;
    const next: UsageBlock = { role: "user", turnMetrics };
    if (typeof block.id === "string" && block.id) next.id = block.id;
    const startedAt = usableNumber(block.startedAt);
    const sentAt = usableNumber(block.sentAt);
    if (startedAt != null) next.startedAt = startedAt;
    if (sentAt != null) next.sentAt = sentAt;
    const modelIn = block.turnModel;
    if (modelIn && typeof modelIn === "object") {
      const model = modelIn as Record<string, unknown>;
      const harness = typeof model.harness === "string" ? model.harness.trim() : "";
      const name = typeof model.name === "string" ? model.name.trim() : "";
      if (harness || name) next.turnModel = { harness, name };
    }
    blocks.push(next);
  }
  return blocks;
}

/**
 * Read the rows. Throws when the payload is not a list, so a broken reply is a failed load and not an empty history.
 * A bad row inside a real list is skipped.
 */
export function readUsageSessions(payload: unknown): UsageSession[] {
  if (!Array.isArray(payload)) {
    throw new Error("usage rows were not a list");
  }
  const sessions: UsageSession[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    const blocks = readBlocks(row.blocks);
    if (blocks.length === 0) continue;
    sessions.push({
      id: row.id,
      cwd: typeof row.cwd === "string" ? row.cwd : "",
      harness: typeof row.harness === "string" ? row.harness : "",
      model: typeof row.model === "string" ? row.model : "",
      blocks,
    });
  }
  return sessions;
}
