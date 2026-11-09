import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import type { UsageBlock, UsageSession, UsageTurnMetrics } from "./history";

/**
 * WP-127: which provider and model the usage history shows.
 *
 * An empty string means all. A value read from settings or another window is
 * untrusted: anything that is not a name falls back to all, and the word "all"
 * does too, so a bad save shows every turn instead of none.
 */

export type UsageFilter = {
  provider: string;
  model: string;
};

export type UsageFilterChoice = {
  id: string;
  label: string;
};

export function defaultUsageFilter(): UsageFilter {
  return { provider: "", model: "" };
}

export function usageFilterIsAll(filter: UsageFilter): boolean {
  return filter.provider === "" && filter.model === "";
}

function choice(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\r/g, "");
  if (!trimmed || trimmed.toLowerCase() === "all") return "";
  return trimmed;
}

/** A filter from disk, a setting, or another window. Anything unreadable means all. */
export function usageFilterFrom(value: unknown): UsageFilter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultUsageFilter();
  const record = value as { provider?: unknown; model?: unknown };
  return { provider: choice(record.provider), model: choice(record.model) };
}

function usable(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A user turn history would count. Assistant text and empty metrics are not turns. */
function isCountedTurn(block: UsageBlock | null | undefined): block is UsageBlock {
  if (!block || block.role !== "user" || !block.turnMetrics) return false;
  const metrics: UsageTurnMetrics = block.turnMetrics;
  return (
    usable(metrics.inputTokens) ||
    usable(metrics.outputTokens) ||
    usable(metrics.cacheReadTokens) ||
    usable(metrics.cacheWriteTokens) ||
    usable(metrics.costUsd)
  );
}

function turnProvider(session: UsageSession, block: UsageBlock): string {
  const fromTurn =
    typeof block.turnModel?.harness === "string" ? block.turnModel.harness.trim() : "";
  if (fromTurn) return fromTurn;
  const fromSession = typeof session.harness === "string" ? session.harness.trim() : "";
  return fromSession || "unknown";
}

function turnModelName(session: UsageSession, block: UsageBlock): string {
  const fromTurn = typeof block.turnModel?.name === "string" ? block.turnModel.name.trim() : "";
  if (fromTurn) return fromTurn;
  const fromSession = typeof session.model === "string" ? session.model.trim() : "";
  return fromSession || "Unknown model";
}

function matches(session: UsageSession, block: UsageBlock, filter: UsageFilter): boolean {
  if (filter.provider && turnProvider(session, block) !== filter.provider) return false;
  if (filter.model && turnModelName(session, block) !== filter.model) return false;
  return true;
}

function providerLabel(id: string): string {
  return HARNESS_TITLE[id as HarnessId] ?? id;
}

function sorted(choices: Map<string, string>): UsageFilterChoice[] {
  return [...choices.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * Providers across every turn, and models for the provider currently chosen
 * (or every model, when the provider is all). Names are de-duplicated.
 */
export function usageFilterChoices(
  sessions: readonly UsageSession[] | null | undefined,
  provider = "",
): { providers: UsageFilterChoice[]; models: UsageFilterChoice[] } {
  const providers = new Map<string, string>();
  const models = new Map<string, string>();
  const list = Array.isArray(sessions) ? sessions : [];
  const wanted = choice(provider);
  for (const session of list) {
    if (!session || typeof session !== "object") continue;
    for (const block of session.blocks ?? []) {
      if (!isCountedTurn(block)) continue;
      const providerId = turnProvider(session, block);
      if (!providers.has(providerId)) providers.set(providerId, providerLabel(providerId));
      if (wanted && providerId !== wanted) continue;
      const modelId = turnModelName(session, block);
      if (!models.has(modelId)) models.set(modelId, modelId);
    }
  }
  return { providers: sorted(providers), models: sorted(models) };
}

/**
 * Sessions whose counted turns match the filter. The input is not changed.
 * A session with no matching turn is left out. With no filter, the sessions
 * come back as they were.
 */
export function applyUsageFilter(
  sessions: readonly UsageSession[] | null | undefined,
  filter: unknown,
): UsageSession[] {
  const list = Array.isArray(sessions) ? sessions : [];
  const chosen = usageFilterFrom(filter);
  const kept: UsageSession[] = [];
  for (const session of list) {
    if (!session || typeof session !== "object") continue;
    if (usageFilterIsAll(chosen)) {
      kept.push(session);
      continue;
    }
    const blocks: UsageBlock[] = Array.isArray(session.blocks) ? session.blocks : [];
    const next = blocks.filter((block) => !isCountedTurn(block) || matches(session, block, chosen));
    if (!next.some((block) => isCountedTurn(block))) continue;
    if (next.length === blocks.length) kept.push(session);
    else kept.push({ ...session, blocks: next });
  }
  return kept;
}
