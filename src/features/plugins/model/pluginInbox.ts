// Everything waiting on the person's OK (an agent's install, or a script) becomes one Inbox card.
import type { PendingRequest } from "./pluginInstall";

export type PluginInboxCard = {
  id: string;
  title: string;
  body: string;
  commands: string[];
  /** WP-101: what the install check found worth reading, in its own section. A block never reaches a card. */
  findings: { path: string; message: string }[];
  /** One plain line about the check, or empty when the request carries no scan. */
  scanLine: string;
};

/**
 * The scan as the card shows it: only rows a person should read (warnings). Anything not shaped as a finding is
 * dropped, since it comes from a file on disk and is not to be trusted.
 */
function readScan(scan: PendingRequest["scan"]): PluginInboxCard["findings"] {
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.findings)) return [];
  const out: PluginInboxCard["findings"] = [];
  for (const item of scan.findings) {
    if (!item || typeof item !== "object") continue;
    const { severity, message } = item as { severity?: unknown; message?: unknown };
    if (severity !== "warn" || typeof message !== "string") continue;
    const text = message.replace(/\r/g, "").trim();
    if (!text || text.includes("\0")) continue;
    const raw = (item as { path?: unknown }).path;
    const path = typeof raw === "string" ? raw.replace(/\r/g, "").trim() : "";
    out.push({ path: path && !path.includes("\0") ? path : "", message: text });
  }
  return out;
}

function scanLineFor(scan: PendingRequest["scan"], findings: readonly unknown[]): string {
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.findings)) return "";
  if (findings.length === 0) return "The install check found nothing to flag.";
  const things = findings.length === 1 ? "1 thing" : `${findings.length} things`;
  return `The install check found ${things} to know about. None of them stops the install.`;
}

export function pluginInboxCards(pending: readonly PendingRequest[]): PluginInboxCard[] {
  return [...pending]
    .filter((request) => typeof request?.id === "string" && typeof request?.name === "string")
    .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0) || a.id.localeCompare(b.id))
    .map(toCard);
}

function toCard(request: PendingRequest): PluginInboxCard {
  const version = request.version ? ` ${request.version}` : "";
  const who =
    request.requestedBy?.kind === "agent"
      ? "An agent asked to install this."
      : "This needs your OK before it runs.";
  const reason = request.requestedBy?.reason ? ` ${request.requestedBy.reason}` : "";
  const replaces = request.replaces ? ` It would replace ${request.replaces}.` : "";
  const commands = (request.steps ?? [])
    .map((step) => (step.run ?? []).join(" "))
    .filter((command) => command.length > 0);
  const scripts = commands.length ? ` It will run: ${commands.join("; ")}.` : " Nothing will run.";
  const verb = request.op === "update" ? "Update" : "Install";
  const findings = readScan(request.scan);
  return {
    id: request.id,
    title: `${verb} ${request.name}${version}`,
    body: `${who}${reason}${replaces}${scripts}`,
    commands,
    findings,
    scanLine: scanLineFor(request.scan, findings),
  };
}
