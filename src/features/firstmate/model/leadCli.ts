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

export type LeadAttach = "claude-args" | "codex-config" | "none";

export type LeadCapability = {
  /** The lead tools attach for a Mono chat or a coding-team chat. */
  leads: boolean;
  attach: LeadAttach;
  /** Why not, when leads is false. Empty when this CLI can lead. */
  reason: string;
};

const NO_HOST = "This CLI has no MCP host the app can set for one chat.";
const SECRET_IN_REQUEST =
  "This CLI can take MCP servers, but the app cannot give it the lead tools without putting the connection secret in the session request.";

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
      : "This CLI is not in the lead table.";
  return `${name} cannot lead yet. ${reason}`;
}

export type LeadCliPresence = {
  cli: string;
  installed: boolean;
  /** Absent counts as signed in. False keeps it out of the picker. */
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
 * Point the same chat at a capable CLI. Crew and memory stay the same objects.
 * Null when the CLI cannot lead, so a bad value changes nothing.
 */
export function applyLeadSwitch<T extends { harness: string }, C, M>(
  session: T,
  cli: string,
  kept: { crew: C; memory: M },
): { session: T; crew: C; memory: M } | null {
  if (!isCli(cli) || !canLead(cli)) return null;
  return {
    session: session.harness === cli ? session : { ...session, harness: cli },
    crew: kept.crew,
    memory: kept.memory,
  };
}

/** The monocode server Codex stores under mcp_servers.monocode. */
export function codexLeadServer(cli: string): Record<string, unknown> {
  return {
    command: cli,
    args: ["mcp"],
    env_vars: [...CODEX_LEAD_ENV_VARS],
    default_tools_approval_mode: "approve",
  };
}
