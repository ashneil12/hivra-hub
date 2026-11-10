/**
 * WP-176. A spend ceiling for one run on a model its provider bills per token.
 * Off unless the person sets one. The soft share asks once. The hard cap stops
 * that run only. A project or app limit never uses this stop.
 */

const MICRO = 1_000_000;
const MAX_AMOUNT_USD = 1_000_000_000;

export type TaskCeiling = {
  hardUsd?: number;
  softAt?: number;
  dailyUsd?: number;
};

export type CeilingInput = {
  ceiling: TaskCeiling | null;
  billed: boolean;
  reportsCost: boolean;
  taskMeasuredUsd: number;
  taskPricedTurns: number;
  taskUnpricedTurns: number;
  dailyMeasuredUsd: number;
  unattended: boolean;
  asked: boolean;
  continued: boolean;
};

export type CeilingVerdict = {
  status: "unset" | "ok" | "ask" | "stop" | "unmeasured";
  reason: string;
  stopRun: boolean;
  ask: boolean;
};

const UNSET: CeilingVerdict = { status: "unset", reason: "", stopRun: false, ask: false };
const OK: CeilingVerdict = { status: "ok", reason: "", stopRun: false, ask: false };

function money(usd: number): number | undefined {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_AMOUNT_USD) return undefined;
  const scaled = Math.round(usd * MICRO);
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

function dollars(micros: number): string {
  const cents = Math.round(micros / 10_000);
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

/** A broken ceiling is dropped. Omitted fields stay off. */
export function sanitizeTaskCeiling(raw: unknown): TaskCeiling | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const hard = row.hardUsd === undefined ? undefined : money(row.hardUsd as number);
  const daily = row.dailyUsd === undefined ? undefined : money(row.dailyUsd as number);
  if (row.hardUsd !== undefined && hard === undefined) return null;
  if (row.dailyUsd !== undefined && daily === undefined) return null;
  if (hard === undefined && daily === undefined) return null;
  let softAt: number | undefined;
  if (row.softAt !== undefined) {
    if (typeof row.softAt !== "number" || !Number.isFinite(row.softAt) || row.softAt < 0.5 || row.softAt > 1) return null;
    softAt = row.softAt;
  }
  return {
    ...(hard !== undefined ? { hardUsd: hard / MICRO, softAt: softAt ?? 0.8 } : {}),
    ...(daily !== undefined ? { dailyUsd: daily / MICRO } : {}),
  };
}

function measured(usd: number): number | undefined {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return undefined;
  const scaled = Math.round(usd * MICRO);
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

/**
 * Checked at the end of a turn, from the cost the CLI reported. The turn that
 * crosses the cap has already run, so the total can overshoot by that turn.
 */
export function ceilingDecision(input: CeilingInput): CeilingVerdict {
  if (!input.billed) return UNSET;
  const ceiling = input.ceiling ? sanitizeTaskCeiling(input.ceiling) : null;
  if (!ceiling) return UNSET;
  if (!input.reportsCost || (input.taskPricedTurns === 0 && input.taskUnpricedTurns > 0 && ceiling.hardUsd != null)) {
    return {
      status: "unmeasured",
      reason: "This CLI reports no cost, so this ceiling cannot count this work.",
      stopRun: false,
      ask: false,
    };
  }
  const task = measured(input.taskMeasuredUsd);
  const daily = measured(input.dailyMeasuredUsd);
  if (task === undefined || (input.unattended && ceiling.dailyUsd != null && daily === undefined)) {
    return {
      status: "stop",
      reason: "Spend for this task could not be read. The run is held until it can.",
      stopRun: true,
      ask: false,
    };
  }
  const hard = ceiling.hardUsd != null ? Math.round(ceiling.hardUsd * MICRO) : undefined;
  if (hard !== undefined && task >= hard) {
    return {
      status: "stop",
      reason: `Task ceiling reached: ${dollars(task)} of ${dollars(hard)}. This run is held.`,
      stopRun: true,
      ask: false,
    };
  }
  const dayCap = ceiling.dailyUsd != null ? Math.round(ceiling.dailyUsd * MICRO) : undefined;
  if (input.unattended && dayCap !== undefined && daily !== undefined && daily >= dayCap) {
    return {
      status: "stop",
      reason: `Daily ceiling reached: ${dollars(daily)} of ${dollars(dayCap)} today. This run is held.`,
      stopRun: true,
      ask: false,
    };
  }
  const soft = hard !== undefined ? Math.round(hard * (ceiling.softAt ?? 0.8)) : undefined;
  if (soft !== undefined && task >= soft && !input.asked && !input.continued) {
    return {
      status: "ask",
      reason: `This task has reached ${dollars(task)} of its ${dollars(hard ?? soft)} ceiling. Continue?`,
      stopRun: false,
      ask: true,
    };
  }
  return OK;
}

/** Hold the task for the person and record the reason once. Other fields stay. */
export function holdTaskForCeiling<T extends { needsYou: boolean; activity: { id: string; text: string }[] }>(
  task: T,
  reason: string,
): T {
  const text = reason.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ").trim();
  if (!text) return { ...task, needsYou: true };
  if (task.activity.some((row) => row.text === text)) return { ...task, needsYou: true };
  return {
    ...task,
    needsYou: true,
    activity: [...task.activity, { id: `ceiling:${task.activity.length + 1}`, text }],
  };
}

/**
 * A reroute onto a billed model needs the person's OK, and the OK has to be
 * exactly true. Anything else leaves the task with the first mate.
 */
export function refuseUnapprovedBilled(input: {
  action: string;
  to?: string;
  billed: boolean;
  personOk: boolean | undefined;
}): { action: string; to?: string; reason: string } {
  if (input.action === "reroute" && input.billed && input.personOk !== true) {
    return { action: "first-mate", reason: "A billed model needs your OK before this task moves." };
  }
  return { action: input.action, ...(input.to ? { to: input.to } : {}), reason: "" };
}
