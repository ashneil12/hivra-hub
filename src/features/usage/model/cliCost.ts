import { HARNESSES, type HarnessId } from "../../sessions/model/session";

/**
 * WP-176. Whether a finished turn from this CLI carries `costUsd`.
 *
 * Claude Code reads `total_cost_usd` (`claudeProtocol.ts`) and opencode reads its
 * reported cost (`opencodeProtocol.ts`). Every other CLI Hivra drives leaves the
 * field unset. A subscription login may still send an API-equivalent figure or
 * none; that is only known from a real turn. This is measured cost, never a bill.
 * An unknown CLI reports nothing, so a limit cannot count its work.
 */
export const CLI_REPORTS_MEASURED_COST: Record<HarnessId, boolean> = {
  claude: true,
  opencode: true,
  codex: false,
  cursor: false,
  grok: false,
  pi: false,
  omp: false,
  fx: false,
  hermes: false,
  antigravity: false,
  devin: false,
};

/** The only name a limit uses for this figure. Never "your bill". */
export const MEASURED_COST_LABEL = "measured cost";

export function cliReportsCost(harness: string | undefined | null): boolean {
  if (typeof harness !== "string") return false;
  const id = harness.trim().toLowerCase();
  if (!HARNESSES.includes(id as HarnessId)) return false;
  return CLI_REPORTS_MEASURED_COST[id as HarnessId] === true;
}

export type TurnPrice = { kind: "priced"; usd: number } | { kind: "unpriced" } | { kind: "empty" };

function usableCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function hasCounts(row: Record<string, unknown>): boolean {
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return true;
  }
  return false;
}

/**
 * One turn's reported price. A missing, negative, or non-finite price is unpriced
 * when the turn has counts, and empty when it reported nothing. It is never $0
 * unless the CLI itself reported 0.
 */
export function readTurnPrice(metrics: unknown): TurnPrice {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return { kind: "empty" };
  const row = metrics as Record<string, unknown>;
  const cost = usableCost(row.costUsd);
  if (cost !== undefined) return { kind: "priced", usd: cost };
  if (hasCounts(row) || "costUsd" in row) return { kind: "unpriced" };
  return { kind: "empty" };
}

export type ReportedTotal = {
  measuredUsd: number;
  pricedTurns: number;
  unpricedTurns: number;
};

function micro(usd: number): number | undefined {
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  const scaled = Math.round(usd * 1_000_000);
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

/** Sum reported prices. An unpriced or non-finite row is counted apart, never added as $0. */
export function addReportedCost(rows: readonly TurnPrice[]): ReportedTotal {
  let micros = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  for (const row of rows) {
    if (!row || row.kind === "empty") continue;
    if (row.kind === "unpriced") {
      unpricedTurns += 1;
      continue;
    }
    const part = micro(row.usd);
    if (part === undefined) {
      unpricedTurns += 1;
      continue;
    }
    const next = micros + part;
    micros = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
    pricedTurns += 1;
  }
  return { measuredUsd: micros / 1_000_000, pricedTurns, unpricedTurns };
}
