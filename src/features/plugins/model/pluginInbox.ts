// Everything waiting on the person's OK (an agent's install, or a script) becomes one Inbox card.
import type { PendingRequest } from "./pluginInstall";

export type PluginInboxCard = {
  id: string;
  title: string;
  body: string;
  commands: string[];
};

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
  return {
    id: request.id,
    title: `${verb} ${request.name}${version}`,
    body: `${who}${reason}${replaces}${scripts}`,
    commands,
  };
}
