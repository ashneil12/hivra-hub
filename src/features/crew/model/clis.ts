/** The agent CLIs a crew rule can name, in the order a fallback walks them. Matches `CREW_CLIS`. */
export const CLI_ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "omp",
  "fx",
  "grok",
  "hermes",
  "devin",
  "antigravity",
] as const;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type CliName = (typeof CLI_ORDER)[number];
export type EffortName = (typeof EFFORTS)[number];

const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "Omp",
  fx: "Fx",
  grok: "Grok",
  hermes: "Hermes",
  devin: "Devin",
  antigravity: "Antigravity",
};

export function isCli(value: string): value is CliName {
  return (CLI_ORDER as readonly string[]).includes(value);
}

export function isEffort(value: string): value is EffortName {
  return (EFFORTS as readonly string[]).includes(value);
}

export function cliLabel(cli: string): string {
  return CLI_LABELS[cli] ?? cli;
}
