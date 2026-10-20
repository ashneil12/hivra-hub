// The MCP servers a hub chat's Claude Code session gets (docs/PHASE-2-DESIGN.md, decisions 2 and 3; H3): ONE
// `--mcp-config` per chat, through the extra-arguments seam (claudeExtraArgs.ts; MonoCode registers nothing there).
//
// - `ash-os`: Ash's own ash-os entry (read in Rust, `hub_ash_os_mcp`; none in a dev copy) with the chat's identity in its
//   env, for every hub chat: ASH_CHAT always; a Mono's chat and its habit runs also ASH_MONO_ID and ASH_ROLE (lead,
//   mono, or checker for the checker); a worker (a chat a Mono or another chat started) ASH_ROLE=worker. Claude Code
//   doesn't hand MCP servers the chat's identity, so it has to be in the entry. This entry replaces a user-scope
//   `ash-os` of the same name (checked with Claude Code 2.1.302 on 19 Oct: only the --mcp-config one started).
// - `monocode`: the delegate tool (`monocode mcp`, src-tauri/src/mcp_server.rs), for a Mono's own chat only (never a
//   habit run, a worker, a plain chat or the checker), pre-approved with `--allowedTools mcp__monocode__*`. Its app
//   connection is written as "${MONOCODE_APP_ENDPOINT}" / "${MONOCODE_APP_TOKEN}": Claude Code expands `${VAR}` in a
//   --mcp-config entry from its own environment, where MonoCode put them for this chat (control.rs configure_child),
//   so the token never appears in argv (checked with 2.1.302 on 19 Oct; an unset variable stays the literal text,
//   which the server treats as no connection). `timeout` lets a wait run its full hour: Claude Code otherwise cuts an
//   MCP call off after its default and a silent one after 30 minutes.
// - connectors (hubConnectors.ts): for a Mono's own chat and its habit runs, one `<app> connector-run <id> --mono <id>
//   --project <key>…` entry per connector its projects (and its own choices) allow. No login is in them: the launcher
//   re-checks the rules and reads the login from the Keychain when Claude Code starts it.
import type { AshOsServer } from "./hubLeads";

/** The checker's Mono id (the studio's tests and lanes use it; hubChecker.ts makes the Mono). */
export const CHECKER_MONO_ID = "checker";

/**
 * The checker's own Claude Code tools (H6), for its chat and its habit runs: Bash for the app CLI (which gives it its
 * memory and soul and refuses it everything else, agentApp.ts) and reading, nothing more. No subagents and no file edits,
 * so it can't start work through its own session either, and the obvious doors out of its lane stay shut: the `ash` CLI
 * (it would run as Ash, with no identity) and another `claude`. A deny rule holds in every permission mode, a habit
 * run's full access included; `--tools` keeps the rest off its tool list altogether.
 */
export const CHECKER_TOOLS = ["Bash", "Read", "Grep", "Glob"];
export const CHECKER_DENIED_TOOLS = ["Agent", "Task", "Edit", "Write", "NotebookEdit", "Bash(ash:*)", "Bash(claude:*)"];
/** Its ash-os tools need no approval: Ash OS offers the checker only its queue, its notes and a few reads. */
export const CHECKER_ALLOWED_TOOLS = "mcp__ash-os__*";

export function checkerToolArgs(): string[] {
  return [
    "--tools",
    CHECKER_TOOLS.join(","),
    "--disallowedTools",
    CHECKER_DENIED_TOOLS.join(","),
    "--allowedTools",
    CHECKER_ALLOWED_TOOLS,
  ];
}

/** Just over the longest wait (60 minutes), as T3 Code does. */
export const MONOCODE_TOOL_TIMEOUT_MS = 3_900_000;
export const MONOCODE_ALLOWED_TOOLS = "mcp__monocode__*";

export type HubRole = "lead" | "mono" | "worker" | "checker";

/** Who a chat is to Ash OS. */
export type HubChatIdentity = {
  /** A Mono's own chat, one of its habit runs, a worker, or a plain hub chat. */
  kind: "mono" | "habit" | "worker" | "chat";
  /** The hub chat (ASH_CHAT): what a chat with no Mono records is its own. */
  chat: string;
  monoId?: string;
  role?: HubRole;
};

/** What the identity is read from; the app's own lookups by default (hubData.ts passes them). */
export type HubChatLookups = {
  /** The Mono whose own chat this is. */
  monoOf(sessionId: string): { id: string } | undefined;
  /** The Mono a habit run works for. */
  habitRunMono(sessionId: string): string | undefined;
  isLead(monoId: string): boolean;
};

function monoRole(monoId: string, lookups: HubChatLookups): HubRole {
  if (monoId === CHECKER_MONO_ID) return "checker";
  return lookups.isLead(monoId) ? "lead" : "mono";
}

/**
 * A Mono's chat is the Mono; a habit run works as its Mono; a chat started through the app CLI (`app-<caller>-<request>`,
 * every delegated worker) is a worker; anything else is a plain hub chat, known by its id alone.
 */
export function hubChatIdentity(sessionId: string, lookups: HubChatLookups): HubChatIdentity {
  const own = lookups.monoOf(sessionId)?.id;
  if (own) return { kind: "mono", chat: sessionId, monoId: own, role: monoRole(own, lookups) };
  const habit = lookups.habitRunMono(sessionId);
  if (habit) return { kind: "habit", chat: sessionId, monoId: habit, role: monoRole(habit, lookups) };
  if (sessionId.startsWith("app-")) return { kind: "worker", chat: sessionId, role: "worker" };
  return { kind: "chat", chat: sessionId };
}

/** Whether this chat gets the delegate tool: a Mono's own chat, and not the checker's (it only reads). */
export function getsDelegateTool(identity: HubChatIdentity): boolean {
  return identity.kind === "mono" && identity.role !== "checker";
}

/** The `monocode` entry. `cli` is this app's own executable (`app_cli_path`). */
export function monocodeServer(cli: string): Record<string, unknown> {
  return {
    command: cli,
    args: ["mcp"],
    env: {
      MONOCODE_APP_ENDPOINT: "${MONOCODE_APP_ENDPOINT}",
      MONOCODE_APP_TOKEN: "${MONOCODE_APP_TOKEN}",
    },
    timeout: MONOCODE_TOOL_TIMEOUT_MS,
  };
}

export type HubMcpServers = {
  /** Ash's ash-os entry, or null (a dev copy, or Claude Code has none). */
  ashOs: AshOsServer | null;
  /** This app's executable, or null when it couldn't be read. */
  cli: string | null;
  /** A Mono's connector entries (hubConnectors.connectorServersForMono); none when absent. */
  connectors?: (monoId: string) => Record<string, unknown>;
};

function identityEnv(identity: HubChatIdentity): Record<string, string> {
  return {
    ...(identity.monoId ? { ASH_MONO_ID: identity.monoId } : {}),
    ...(identity.role ? { ASH_ROLE: identity.role } : {}),
    ASH_CHAT: identity.chat,
  };
}

/** The extra Claude Code arguments for one chat: one --mcp-config, plus the delegate tool's approval. */
export function hubMcpArgs(
  sessionId: string,
  servers: HubMcpServers,
  lookups: HubChatLookups,
): string[] {
  const identity = hubChatIdentity(sessionId, lookups);
  // The checker only reads, whatever else this chat gets.
  const restrict = identity.role === "checker" ? checkerToolArgs() : [];
  const mcpServers: Record<string, unknown> = {};
  // A Mono's connectors go in first, so the hub's own entries below always keep their names.
  if (servers.connectors && identity.monoId && (identity.kind === "mono" || identity.kind === "habit"))
    Object.assign(mcpServers, servers.connectors(identity.monoId));
  if (servers.ashOs) {
    const { ashOs } = servers;
    // The server's own settings stay; who is calling is only ever this chat's identity, never Ash's config's.
    const {
      ASH_MONO_ID: _mono,
      ASH_ROLE: _role,
      ASH_CHAT: _chat,
      ...own
    } = ashOs.env ?? {};
    mcpServers["ash-os"] = { ...ashOs, env: { ...own, ...identityEnv(identity) } };
  }
  const delegate = !!servers.cli && getsDelegateTool(identity);
  if (delegate) mcpServers.monocode = monocodeServer(servers.cli!);
  if (!Object.keys(mcpServers).length) return restrict;
  return [
    ...restrict,
    ...(delegate ? ["--allowedTools", MONOCODE_ALLOWED_TOOLS] : []),
    "--mcp-config",
    JSON.stringify({ mcpServers }),
  ];
}

let registered: { servers: HubMcpServers; lookups: HubChatLookups } | undefined;

/** hubData.ts registers the servers once it has read them; until then (and outside the hub) nothing is added. */
export function setHubMcpServers(
  servers: HubMcpServers | undefined,
  lookups?: HubChatLookups,
): void {
  registered = servers && lookups ? { servers, lookups } : undefined;
}

/** The registered servers' arguments for a chat (the seam's provider). */
export function registeredHubMcpArgs(sessionId: string): string[] {
  return registered ? hubMcpArgs(sessionId, registered.servers, registered.lookups) : [];
}

/**
 * Whether a chat's Claude Code session has the delegate tool, so its context can teach it (monoFiles.ts
 * `<delegate_rules>`). Only Claude Code sessions take the extra arguments.
 */
export function hasDelegateTool(sessionId: string, harness: string): boolean {
  if (harness !== "claude" || !registered?.servers.cli) return false;
  return getsDelegateTool(hubChatIdentity(sessionId, registered.lookups));
}
