// WP-160: a project's lead tick. Off unless the person turns it on, and Ship on green stays off until they turn that on
// too. A value from disk or another window is untrusted: anything that is not a real true is off.

export const LEAD_TICK_DOC_KEY = "lead-tick";
export const DEFAULT_INTERVAL_MINUTES = 15;
export const MIN_INTERVAL_MINUTES = 5;
/** Four hours. A longer gap is not a lead keeping watch. */
export const MAX_INTERVAL_MINUTES = 240;

export type LeadTickSetting = {
  /** The tick runs for this project. */
  enabled: boolean;
  /** Minutes between ticks: at least 5, 15 unless the person changed it. */
  intervalMinutes: number;
  /** A green, non-parked programme pull request goes to the project's merge path. Off means the tick only reports. */
  shipOnGreen: boolean;
};

export function defaultLeadTickSetting(): LeadTickSetting {
  return { enabled: false, intervalMinutes: DEFAULT_INTERVAL_MINUTES, shipOnGreen: false };
}

function interval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(value)));
}

export function readLeadTickSetting(raw: unknown): LeadTickSetting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultLeadTickSetting();
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    intervalMinutes: interval(value.intervalMinutes),
    shipOnGreen: value.shipOnGreen === true,
  };
}
