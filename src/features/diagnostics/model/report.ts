// WP-104: the text a person copies from Settings. Home paths become ~ and the shared secret list is applied
// before anything reaches the clipboard.

import { redactText } from "../../portable/model/secrets";

export const DIAGNOSTICS_LOG_LINES = 200;

export type DiagnosticsReportInput = {
  version: string;
  build: string;
  os: string;
  home: string;
  lines: readonly string[];
  crashes: readonly string[];
  health: readonly string[];
};

/** Replace a home folder with ~, and not a longer name that only starts the same way. */
export function maskHome(text: string, home: string): string {
  const trimmed = home.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return text;
  const flipped = trimmed.includes("\\") ? trimmed.split("\\").join("/") : trimmed.split("/").join("\\");
  const homes = flipped === trimmed ? [trimmed] : [trimmed, flipped];
  homes.sort((a, b) => b.length - a.length);
  let out = text;
  for (const folder of homes) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "g"), "~");
  }
  return out;
}

function section(lines: readonly string[], empty: string): string {
  return lines.length > 0 ? lines.join("\n") : empty;
}

/**
 * One plain-text block: version, system, health, the last 200 log lines and the crash records.
 * A planted key and a home path do not survive.
 */
export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const lines = input.lines.slice(-DIAGNOSTICS_LOG_LINES);
  const health = section(input.health, "No check yet.");
  const log = section(lines, "None.");
  const crashes = section(input.crashes, "None.");
  const raw = [
    "Hivra diagnostics",
    `Version: ${input.version}`,
    `Build: ${input.build}`,
    `System: ${input.os}`,
    "",
    "Health",
    health,
    "",
    "Recent log",
    log,
    "",
    "Crash records",
    crashes,
    "",
  ].join("\n");
  return redactText(maskHome(raw, input.home)).text;
}
