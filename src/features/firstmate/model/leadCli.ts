// WP-120: which CLIs can lead a crew. Capable ones get the lead tools. The rest
// keep a written reason, shown in the lead chat, instead of a silent no-op.
//
// Codex gets the same monocode server Claude does, but as Codex config: command,
// args, and the names of the app env vars. The values stay on the harness
// process (control.rs configure_child). ACP hosts would need those values inside
// the session request, which the webview must not see, so they cannot lead yet.
import type { HarnessId } from "../../sessions/model/session";
import { HARNESS_TITLE, HARNESSES } from "../../sessions/model/session";
import { CLI_ORDER, cliLabel, isCli } from "../../crew/model/clis";
import { chosenClis } from "../../hub/model/codingTeamHome";

export type LeadAttach = "claude-args" | "codex-config" | "none";

export type LeadCapability = {
  /** The lead tools attach for a Mono chat or a coding-team chat. */
  leads: boolean;
  attach: LeadAttach;
  /** Why not, when leads is false. Empty when this CLI can lead. */
  reason: string;
};

// What a person reads in the lead strip, so no plumbing words: no MCP, host, secret or session request.
const NO_HOST = "The app has no way to give it the tools a lead uses to hand out jobs.";
const SECRET_IN_REQUEST =
  "The app could only give it the tools a lead uses by passing it a private key, and it does not do that yet.";

export const LEAD_CAPABILITY: Record<HarnessId, LeadCapability> = {
  claude: { leads: true, attach: "claude-args", reason: "" },
  codex: { leads: true, attach: "codex-config", reason: "" },
  cursor: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  grok: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  hermes: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  devin: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  antigravity: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  fx: { leads: false, attach: "none", reason: SECRET_IN_REQUEST },
  opencode: { leads: false, attach: "none", reason: NO_HOST },
  pi: { leads: false, attach: "none", reason: NO_HOST },
  omp: { leads: false, attach: "none", reason: NO_HOST },
};

/** Env names Codex passes through to the monocode server. Never the values. */
export const CODEX_LEAD_ENV_VARS = ["MONOCODE_APP_ENDPOINT", "MONOCODE_APP_TOKEN"] as const;

/**
 * Just over the longest task_wait (60 minutes), the same limit Claude gets (hubMcp.ts MONOCODE_TOOL_TIMEOUT_MS).
 * Codex cuts an MCP call off after 300 s unless the server sets tool_timeout_sec, and task_wait runs 10 minutes by default.
 */
export const CODEX_LEAD_TOOL_TIMEOUT_SEC = 3900;

export function canLead(harness: string): boolean {
  return harness in LEAD_CAPABILITY && LEAD_CAPABILITY[harness as HarnessId].leads;
}

/** The sentence a lead chat shows when this CLI cannot lead. Null when it can. */
export function leadBlockReason(harness: string): string | null {
  if (canLead(harness)) return null;
  const known = (HARNESSES as readonly string[]).includes(harness);
  const name = known ? HARNESS_TITLE[harness as HarnessId] : harness.trim() || "This CLI";
  const reason =
    known && harness in LEAD_CAPABILITY
      ? LEAD_CAPABILITY[harness as HarnessId].reason
      : "The app does not know this CLI.";
  return `${name} cannot lead yet. ${reason}`;
}

export type LeadCliPresence = {
  cli: string;
  installed: boolean;
  /** Absent means the app did not check, and does not keep the CLI out. False does. */
  signedIn?: boolean;
};

export type LeadChoice = { cli: HarnessId; label: string };

/** Capable CLIs that are installed and signed in, in crew order, once each. */
export function leadPickerChoices(present: readonly LeadCliPresence[]): LeadChoice[] {
  const ready = new Set<string>();
  for (const row of present) {
    if (!row || !row.installed || row.signedIn === false) continue;
    if (!isCli(row.cli) || !canLead(row.cli)) continue;
    ready.add(row.cli);
  }
  return CLI_ORDER.filter((cli) => ready.has(cli)).map((cli) => ({
    cli,
    label: cliLabel(cli),
  }));
}

/**
 * The CLIs Ash ticked at first launch, each with whether it is installed here.
 * Nothing claims a sign-in the app did not see, so `signedIn` stays absent.
 */
export function chosenLeadPresence(
  isInstalled: (cli: HarnessId) => boolean,
): LeadCliPresence[] {
  return chosenClis().map((cli) => ({ cli, installed: isInstalled(cli) }));
}

/**
 * A switch when the current CLI cannot lead. The choices are the capable CLIs
 * that are here. Null when this CLI can already lead.
 */
export function leadSwitchOffer(
  current: string,
  present: readonly LeadCliPresence[],
): { reason: string; choices: LeadChoice[] } | null {
  const reason = leadBlockReason(current);
  if (!reason) return null;
  return { reason, choices: leadPickerChoices(present) };
}

/**
 * The CLI this same chat should lead on after a pick. Only the chat's harness
 * changes, so its id, blocks, crew and memory stay with it. Null when the pick
 * changes nothing, names a CLI that cannot lead, or is not a CLI at all, so a
 * bad pick never turns the chat into a lead without tools.
 */
export function applyLeadSwitch(harness: string, cli: string): HarnessId | null {
  if (!isCli(cli) || !canLead(cli) || cli === harness) return null;
  return cli;
}

/** The monocode server Codex stores under mcp_servers.monocode. */
export function codexLeadServer(cli: string): Record<string, unknown> {
  return {
    command: cli,
    args: ["mcp"],
    env_vars: [...CODEX_LEAD_ENV_VARS],
    tool_timeout_sec: CODEX_LEAD_TOOL_TIMEOUT_SEC,
    default_tools_approval_mode: "approve",
  };
}
