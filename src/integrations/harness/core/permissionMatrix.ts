import {
  RUNTIME_MODE_HINT,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODES,
  type RuntimeMode,
} from "../../../features/sessions/model/session";

/**
 * One permission table for every CLI adapter (WP-175).
 *
 * Each row is a Hivra mode, or `plan` for a planning turn, and each cell is the
 * setting that CLI receives for it. `rank` orders the settings of one CLI from
 * strictest (lowest) to most permissive; a change may only move a session to a
 * setting of equal or higher rank when the person chose it.
 *
 * The adapters read their mapping from here, so the table is the single place
 * to read or change what a mode means on a CLI. Keep the cells equal to what the
 * adapters did before this table existed unless a change is deliberate and
 * tested; `permissionMatrix.test.ts` fails on any looser setting.
 */

export const PERMISSION_CLIS = ["claude", "antigravity", "devin", "fx"] as const;
export type PermissionCli = (typeof PERMISSION_CLIS)[number];

/** A Hivra mode, or `plan` for a planning turn (the intent, not a picker mode). */
export type PermissionRowKey = RuntimeMode | "plan";

export type PermissionCell = {
  /** The value the CLI receives (its mode id, or the Claude permission mode). */
  setting: string;
  /** Strictness on this CLI: lower is stricter. Plan is always below Supervised. */
  rank: number;
  /** What this row does on this CLI, in words. Required on the plan row. */
  note?: string;
  /** True where the mapping is weaker than the mode's name says. Listed in the tests. */
  knownGap?: boolean;
};

export type PermissionTable = Record<PermissionCli, Record<PermissionRowKey, PermissionCell>>;

export const PERMISSION_MATRIX: PermissionTable = {
  claude: {
    supervised: { setting: "default", rank: 0, note: "Asks before commands and edits. Sent explicitly, so the user's own defaultMode never applies." },
    "auto-accept-edits": { setting: "acceptEdits", rank: 1 },
    auto: { setting: "auto", rank: 2 },
    "full-access": { setting: "bypassPermissions", rank: 3, note: "Only a process started for Full access can take it live." },
    plan: { setting: "plan", rank: -1, note: "Planning turns send `--permission-mode plan` in place of the chat's mode." },
  },
  antigravity: {
    supervised: { setting: "default", rank: 0 },
    "auto-accept-edits": { setting: "auto_edit", rank: 1 },
    auto: { setting: "default", rank: 0, knownGap: true, note: "No separate setting. Runs as default, so approvals are not reviewed by an AI." },
    "full-access": { setting: "yolo", rank: 2 },
    plan: { setting: "default", rank: -1, note: "No native plan mode. Runs as default and denies every non-read request on the client." },
  },
  devin: {
    supervised: { setting: "accept-edits", rank: 0, note: "accept-edits plus a Write(**) ask rule, so edits reach the approval prompt. The rule restarts the child." },
    "auto-accept-edits": { setting: "accept-edits", rank: 1 },
    auto: { setting: "smart", rank: 2 },
    "full-access": { setting: "bypass", rank: 3 },
    plan: { setting: "plan", rank: -1, note: "Planning turns send Devin's plan mode." },
  },
  fx: {
    supervised: { setting: "code", rank: 1, knownGap: true, note: "fx always runs its code mode, and its permission requests are approved. Supervised does not ask today." },
    "auto-accept-edits": { setting: "code", rank: 1 },
    auto: { setting: "code", rank: 1 },
    "full-access": { setting: "code", rank: 1 },
    plan: { setting: "ask", rank: -1, note: "Planning turns send fx's ask mode and deny every non-read request on the client." },
  },
};

/**
 * The table as it stood before WP-175 (values read from the adapters on 10 Nov 2026).
 * The tests check that no later edit loosens a cell below these.
 */
export const PERMISSION_SNAPSHOT_BEFORE_WP175: PermissionTable = {
  claude: {
    supervised: { setting: "default", rank: 0 },
    "auto-accept-edits": { setting: "acceptEdits", rank: 1 },
    auto: { setting: "auto", rank: 2 },
    "full-access": { setting: "bypassPermissions", rank: 3 },
    plan: { setting: "plan", rank: -1 },
  },
  antigravity: {
    supervised: { setting: "default", rank: 0 },
    "auto-accept-edits": { setting: "auto_edit", rank: 1 },
    auto: { setting: "default", rank: 0 },
    "full-access": { setting: "yolo", rank: 2 },
    plan: { setting: "default", rank: -1 },
  },
  devin: {
    supervised: { setting: "accept-edits", rank: 0 },
    "auto-accept-edits": { setting: "accept-edits", rank: 1 },
    auto: { setting: "smart", rank: 2 },
    "full-access": { setting: "bypass", rank: 3 },
    plan: { setting: "plan", rank: -1 },
  },
  fx: {
    supervised: { setting: "code", rank: 1 },
    "auto-accept-edits": { setting: "code", rank: 1 },
    auto: { setting: "code", rank: 1 },
    "full-access": { setting: "code", rank: 1 },
    plan: { setting: "ask", rank: -1 },
  },
};

export function cliPermissionSetting(cli: PermissionCli, row: PermissionRowKey): string {
  return PERMISSION_MATRIX[cli][row].setting;
}

/**
 * The order in which a session's mode is chosen: the live mode the chat runs
 * on, then its saved mode, then the phone or server payload, then Supervised.
 * Anything that is not a Hivra mode is skipped. There is no sandbox step.
 */
export function resolveRuntimeMode(sources: {
  live?: unknown;
  saved?: unknown;
  payload?: unknown;
}): RuntimeMode {
  for (const candidate of [sources.live, sources.saved, sources.payload]) {
    if (typeof candidate === "string" && (RUNTIME_MODES as string[]).includes(candidate)) {
      return candidate as RuntimeMode;
    }
  }
  return "supervised";
}

/**
 * The mode a phone request leaves a chat on (WP-175 4.1). The chat's own mode is
 * its live mode, else its saved mode. A phone payload that differs from it may
 * only tighten it: the stricter of the two wins, so the phone can never loosen a
 * chat. With no chat mode to protect (a new chat), the payload is taken, then
 * Supervised.
 */
export function resolvePhoneRuntimeMode(sources: {
  live?: unknown;
  saved?: unknown;
  payload?: unknown;
}): RuntimeMode {
  const own = resolveOwnMode(sources.live, sources.saved);
  const requested = resolveOwnMode(sources.payload);
  if (own === undefined) return requested ?? "supervised";
  if (requested === undefined) return own;
  return RUNTIME_MODES.indexOf(requested) < RUNTIME_MODES.indexOf(own) ? requested : own;
}

function resolveOwnMode(...candidates: unknown[]): RuntimeMode | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && (RUNTIME_MODES as string[]).includes(candidate)) {
      return candidate as RuntimeMode;
    }
  }
  return undefined;
}

/**
 * What a mode is called on one CLI (WP-175 4.2 and 4.3). Only where the shared
 * Hivra name would mislead: fx's Supervised does not ask before it acts, and
 * Antigravity's Auto is its default mode with no AI review.
 */
const CLI_MODE_COPY: Partial<Record<PermissionCli, Partial<Record<RuntimeMode, { label: string; hint: string }>>>> = {
  fx: {
    supervised: {
      label: "fx approves its own requests",
      hint: "fx runs its own code mode and approves its requests in code. Nothing is asked before it acts.",
    },
  },
  antigravity: {
    auto: {
      label: "Default (no AI review)",
      hint: "Runs Antigravity's default mode. Its approvals are not reviewed by an AI.",
    },
  },
};

/** The modes a picker offers on a CLI. fx is offered with Full access only for now. */
const CLI_OFFERED_MODES: Partial<Record<PermissionCli, RuntimeMode[]>> = {
  fx: ["full-access"],
};

/** The permission CLI a harness id runs on, or null for a harness with no table here. */
export function permissionCliForHarness(harness: string | null | undefined): PermissionCli | null {
  return (PERMISSION_CLIS as readonly string[]).includes(harness ?? "") ? (harness as PermissionCli) : null;
}

/** The label and hint for a mode on a CLI, the shared Hivra copy where the CLI has none of its own. */
export function runtimeModeCopy(
  mode: RuntimeMode,
  cli: PermissionCli | null,
): { label: string; hint: string } {
  const own = cli ? CLI_MODE_COPY[cli]?.[mode] : undefined;
  return own ?? { label: RUNTIME_MODE_LABEL[mode], hint: RUNTIME_MODE_HINT[mode] };
}

/** The modes a picker offers on a CLI, in the order Hivra lists them. */
export function offeredRuntimeModes(cli: PermissionCli | null): RuntimeMode[] {
  const offered = cli ? CLI_OFFERED_MODES[cli] : undefined;
  return offered ? RUNTIME_MODES.filter((mode) => offered.includes(mode)) : [...RUNTIME_MODES];
}

/** Strictness across Hivra modes: plan is below Supervised, Full access is the top. */
function hivraRank(row: PermissionRowKey): number {
  if (row === "plan") return -1;
  return RUNTIME_MODES.indexOf(row);
}

export type RefusedModeChange =
  | { action: "wait"; message: string }
  | { action: "keep"; message: string };

/**
 * One rule for a mode change a CLI refused. `current` is the mode the process
 * last confirmed, or null when none is known.
 *
 * - A refused downgrade, or any refusal with no known current mode, ends the turn
 *   as waiting. The turn never runs on the looser mode.
 * - A refused upgrade keeps the current (stricter) mode, the turn goes on, and
 *   the message says so.
 */
export function refusedModeChange(
  current: PermissionRowKey | null,
  target: PermissionRowKey,
): RefusedModeChange {
  const targetLabel = target === "plan" ? "Plan" : RUNTIME_MODE_LABEL[target];
  if (current === null) {
    return {
      action: "wait",
      message: `Couldn't switch this chat to ${targetLabel}, so its turn is waiting. Choose a mode and send again.`,
    };
  }
  if (hivraRank(target) > hivraRank(current)) {
    const currentLabel = current === "plan" ? "Plan" : RUNTIME_MODE_LABEL[current];
    return {
      action: "keep",
      message: `Couldn't switch this chat to ${targetLabel}; it stays on ${currentLabel}.`,
    };
  }
  return {
    action: "wait",
    message: `Couldn't switch this chat to ${targetLabel}, so its turn is waiting. Choose a mode and send again.`,
  };
}

/** A transport failure (timeout, dead child, closed pipe): the caller recycles the child instead. */
export function isTransportFailure(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /timed out|not running|exited|closed|pipe/i.test(detail);
}

/** The CLI does not implement the mode control at all, so there is no mode to change. */
export function isUnsupportedControl(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /method not found|-32601|not supported|unsupported/i.test(detail);
}

/** The turn ends as waiting: the CLI refused a change, and the chat must not run on the looser mode. */
export class ModeChangeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeChangeRefused";
  }
}

/**
 * Send one mode change and apply the single refusal rule to it. Transport
 * failures are rethrown so the caller recycles the child as before.
 *
 * `applied`: the CLI took the change. `keep`: refused, the current (stricter)
 * mode stands, and `message` says so. A refused downgrade throws ModeChangeRefused.
 * `unsupported`: the CLI has no such control (only when `ignoreUnsupported`).
 */
export async function changeMode(opts: {
  current: PermissionRowKey | null;
  target: PermissionRowKey;
  send: () => Promise<unknown>;
  ignoreUnsupported?: boolean;
}): Promise<
  | { outcome: "applied" }
  | { outcome: "unsupported" }
  | { outcome: "keep"; message: string; current: PermissionRowKey }
> {
  try {
    await opts.send();
    return { outcome: "applied" };
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    if (opts.ignoreUnsupported && isUnsupportedControl(error)) return { outcome: "unsupported" };
    const decision = refusedModeChange(opts.current, opts.target);
    if (decision.action === "wait") {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ModeChangeRefused(`${decision.message} (${detail})`);
    }
    return { outcome: "keep", message: decision.message, current: opts.current as PermissionRowKey };
  }
}

/**
 * The approval policy a chat keeps when a change was refused: the mode the CLI
 * is still on. Plan keeps plan, and the policy under it is Supervised.
 */
export function policyForKeptMode(current: PermissionRowKey): { runtimeMode: RuntimeMode; planning: boolean } {
  if (current === "plan") return { runtimeMode: "supervised", planning: true };
  return { runtimeMode: current, planning: false };
}

/**
 * A refused change that keeps the current mode: the chat's approval policy goes
 * back to that mode (not the refused one), and the chat says so in a notice.
 */
export function keepCurrentMode(
  live: { runtimeMode: RuntimeMode; planning: boolean; onEvent: (event: { type: "notice"; level: "warning"; key: string; text: string }) => void },
  current: PermissionRowKey,
  message: string,
): void {
  const policy = policyForKeptMode(current);
  live.runtimeMode = policy.runtimeMode;
  live.planning = policy.planning;
  live.onEvent({ type: "notice", level: "warning", key: "mode-refused", text: message });
}
