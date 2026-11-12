// The MCP servers a hub chat's Claude Code session gets (docs/PHASE-2-DESIGN.md, decisions 2 and 3; H3): ONE
// `--mcp-config` per chat, through the extra-arguments seam (claudeExtraArgs.ts; MonoCode registers nothing there).
//
// (The Ash OS entry every hub chat used to get is retired with the bridge: WP-04.)
// - `monocode`: the delegate tool (`monocode mcp`, src-tauri/src/mcp_server.rs), for the chats Ash talks to: a Mono's
//   own chat and a chat in a project's coding team (never a habit run, a worker, another plain chat or the checker),
//   pre-approved with `--allowedTools mcp__monocode__*`. Its app
//   connection is written as "${MONOCODE_APP_ENDPOINT}" / "${MONOCODE_APP_TOKEN}": Claude Code expands `${VAR}` in a
//   --mcp-config entry from its own environment, where MonoCode put them for this chat (control.rs configure_child),
//   so the token never appears in argv (checked with 2.1.302 on 19 Oct; an unset variable stays the literal text,
//   which the server treats as no connection). `timeout` lets a wait run its full hour: Claude Code otherwise cuts an
//   MCP call off after its default and a silent one after 30 minutes.
// - connectors (hubConnectors.ts): for a Mono's own chat and its habit runs, one `<app> connector-run <id> --mono <id>
//   --project <key>…` entry per connector its projects (and its own choices) allow. No login is in them: the launcher
//   re-checks the rules and reads the login from the Keychain when Claude Code starts it.
import { setClaudeGuardArgs } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { GIT_HOOK_DENY_RULES, GUARD_STORE_DENY_RULES, HUB_DB_DENY_RULES, SECRET_ACTION_DENY_RULES } from "../../../integrations/harness/core/credentialGuard";
import { canLead, codexLeadServer } from "../../firstmate/model/leadCli";
import { chatGetsComputerUse, computerUseServer, knownComputerUse } from "../../computerUse/model/computerUse";

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
export function checkerToolArgs(): string[] {
  return [
    "--tools",
    CHECKER_TOOLS.join(","),
    "--disallowedTools",
    [...CHECKER_DENIED_TOOLS, ...chatDeniedTools()].join(","),
  ];
}

/**
 * The Monos' home (src-tauri/src/mono_home.rs): only the app writes there, through its own commands, and checks each
 * write. Every hub chat may read it but is denied edits under it, whatever its permission mode: a deny rule holds even
 * with full access. Claude Code can't fence a shell command by the path it touches, so the briefs carry the rule too
 * (agentAppTasks.ts workerRules, leadershipDelegation.ts) and the app's hash-checked saves refuse to write over a file
 * that changed under them.
 */
export const MONO_HOME = "~/agent-memory/monos";
/**
 * The fence a brief reads. The path is this copy's own home once `mono_home_info` has reported it (`activeHome`),
 * never "~/agent-memory": a model expands that to the real user. Before the home is known, the sentence names no path.
 */
export function monoHomeFence(): string {
  const where = activeHome ? `${activeHome}/` : "this copy's Monos folder";
  return `The Monos' home (${where}) is read-only for you: read a Mono's soul or memory there if it helps, but never write, move or delete anything in it, with any tool or shell command. Only the app changes it.`;
}
let extraHome: string | undefined;
/** The Monos' home this copy uses, absolute (mono_home_info), for telling whose home a chat works in. */
let activeHome: string | undefined;
/**
 * Where this copy's Monos live, when it isn't the daily home (a dev copy's data folder, the bench's throwaway home),
 * from mono_home_info. Written absolute (`//path`). Spaces and "?" are fine: the rule is one argv value and Claude Code
 * reads a rule's parentheses whole (as in "Bash(git log:*)"), and "?" in the path still matches itself. A dev copy's
 * own home is under "Application Support", so dropping spaced paths left every dev copy unfenced (Mac rehearsal, 21
 * Oct). Only what would split the list or the rule (a comma, a parenthesis, a line break) keeps a path out.
 */
export function setMonoHomeRoot(root: string | undefined): void {
  const path = root?.replace(/\/+$/, "");
  activeHome = path && path.startsWith("/") ? path : undefined;
  extraHome = path && path.startsWith("/") && !/[,()\r\n]/.test(path) && !path.endsWith("/agent-memory/monos") ? path : undefined;
}
export function monoHomeDeniedTools(): string[] {
  const roots = [MONO_HOME, ...(extraHome ? [`/${extraHome}`] : [])];
  // Claude Code applies an Edit rule to every built-in tool that edits files (Write and NotebookEdit too).
  return roots.map((root) => `Edit(${root}/**)`);
}

/**
 * No chat reads a saved login to use it itself: in a test run (21 Oct) a worker pulled Ash's GitHub token out of the
 * Keychain with `git credential fill` and opened and merged pull requests on his real repo with it. Git's own pushes
 * still use the login as before; only asking for the secret by hand is refused. Claude Code checks each part of a
 * chained command against these, whatever the permission mode.
 */
export const CREDENTIAL_DENIED_TOOLS = [
  "Bash(git credential:*)",
  "Bash(git credential-osxkeychain:*)",
  "Bash(security find-internet-password:*)",
  "Bash(security find-generic-password:*)",
  "Bash(security dump-keychain:*)",
  "Bash(gh auth token:*)",
];

/**
 * The daily app's Monos moved to ~/agent-memory/monos on 20 Oct (mono_home.rs); the copy they came from stays in its
 * data folder, untouched, until Ash says it can go. That copy is frozen on the old team (ash-lead, no hub-lead, no
 * Bark Desk lead), and a worker that found it reported "ash-lead … the five Leads" as the team (Alfred's A8, 22 Oct).
 * So no hub chat reads it; the live team is in the Monos' home.
 */
export const OLD_MONO_COPY = "~/Library/Application Support/com.ash.monocode-hub/monos";
export const OLD_MONO_COPY_DENIED_TOOLS = [
  `Read(${OLD_MONO_COPY}/**)`,
  "Bash(*com.ash.monocode-hub/monos*)",
];

/**
 * WP-04: the app's own `ash-os` entry used to replace, by name, the one in Ash's own Claude Code settings
 * (~/.claude.json). With it retired, Claude Code would load Ash's, unscoped (no Mono, role or project), in every hub
 * chat. Every tool of a server by that name is denied instead.
 */
export const ASH_OS_DENIED_TOOLS = ["mcp__ash-os"];

/** Everything every hub chat is denied: edits in the Monos' home, the old Mono copy, Ash's own Ash OS server (WP-04), reading a saved login by hand, the hub's database (r67), and any secret action (r69). */
export function chatDeniedTools(): string[] {
  return [...monoHomeDeniedTools(), ...OLD_MONO_COPY_DENIED_TOOLS, ...ASH_OS_DENIED_TOOLS, ...CREDENTIAL_DENIED_TOOLS, ...HUB_DB_DENY_RULES, ...SECRET_ACTION_DENY_RULES, ...GIT_HOOK_DENY_RULES, ...GUARD_STORE_DENY_RULES];
}

/** Where the Monos' homes are: the daily home as written (`~/...`) and this copy's own, absolute, once known. */
export function monoHomeDirs(): string[] {
  return [MONO_HOME, ...(activeHome && activeHome !== MONO_HOME ? [activeHome] : [])];
}

/** Just over the longest wait (60 minutes), as T3 Code does. */
export const MONOCODE_TOOL_TIMEOUT_MS = 3_900_000;
export const MONOCODE_ALLOWED_TOOLS = "mcp__monocode__*";

/** The folder of the hub's bundled docs (hub-docs), once known: the note sends every Mono there, so reading it never asks. */
let hubDocsDir: string | undefined;
export function setHubDocsDir(dir: string | undefined): void {
  hubDocsDir = dir?.replace(/\/+$/, "") || undefined;
}

/**
 * A delegate-tool chat's pre-approvals: the hub's tools, and reading the hub docs its note points at (AD14, run 24bf:
 * a coding-team chat sat on an "Allow Read .../hub-docs/README.md" card for 6 minutes while Ash saw nothing to click).
 */
export function delegateAllowedTools(): string {
  return hubDocsDir ? `${MONOCODE_ALLOWED_TOOLS},Read(/${hubDocsDir}/**)` : MONOCODE_ALLOWED_TOOLS;
}

export type HubRole = "lead" | "mono" | "worker" | "checker";

/** Who a chat is to Ash OS. */
export type HubChatIdentity = {
  /** A Mono's own chat, one of its habit runs, a chat in a project's coding team, a worker, or a plain hub chat. */
  kind: "mono" | "habit" | "team" | "worker" | "chat";
  /** The hub chat (ASH_CHAT): what a chat with no Mono records is its own. */
  chat: string;
  monoId?: string;
  role?: HubRole;
  /**
   * The projects it works on (ASH_PROJECT): a Lead's own project, for its chat, its habit runs and every worker
   * under it, and a coding-team chat's project, for it and its workers. Absent for everyone else (the leadership team
   * reads every project, and names one when an ask does).
   */
  projects?: string[];
};

/** What the identity is read from; the app's own lookups by default (hubData.ts passes them). */
export type HubChatLookups = {
  /** The Mono whose own chat this is. */
  monoOf(sessionId: string): { id: string } | undefined;
  /** The Mono a habit run works for. */
  habitRunMono(sessionId: string): string | undefined;
  isLead(monoId: string): boolean;
  /** The project a Lead leads (hubLeads.ts leadFor); undefined for any other Mono. */
  leadProject?(monoId: string): string | undefined;
  /** The hub project whose coding team this chat is in (codingTeam.ts); undefined for any other chat. */
  codingTeamProject?(sessionId: string): string | undefined;
};

function monoRole(monoId: string, lookups: HubChatLookups): HubRole {
  if (monoId === CHECKER_MONO_ID) return "checker";
  return lookups.isLead(monoId) ? "lead" : "mono";
}

/** A Lead's project, as the list ASH_PROJECT carries; nothing for any other Mono. */
function projectsOf(monoId: string, role: HubRole, lookups: HubChatLookups): { projects?: string[] } {
  const project = role === "lead" ? lookups.leadProject?.(monoId) : undefined;
  return project ? { projects: [project] } : {};
}

/**
 * The chat Ash talks to that a worker was started under, however deep (`app-<caller>-<request>`, where the caller may
 * itself be a worker: `app-app-<Mono's chat>-<r1>-<r2>`): the longest prefix of what follows the `app-`s that is a
 * Mono's own chat or a coding-team chat.
 */
function rootOwnerChat(sessionId: string, lookups: HubChatLookups): string | undefined {
  let rest = sessionId;
  let best: string | undefined;
  while (rest.startsWith("app-")) {
    rest = rest.slice(4);
    for (let at = rest.indexOf("-"); at > 0; at = rest.indexOf("-", at + 1)) {
      const candidate = rest.slice(0, at);
      if (
        (!best || candidate.length > best.length) &&
        (lookups.monoOf(candidate) || lookups.codingTeamProject?.(candidate))
      )
        best = candidate;
    }
  }
  return best;
}

/**
 * A Mono's chat is the Mono; a habit run works as its Mono; a chat started through the app CLI (`app-<caller>-<request>`,
 * every delegated worker) is a worker, and works on its Lead's or coding team's project when the chat it was started
 * under has one; a chat in a project's coding team works on that project; anything else is a plain hub chat, known by
 * its id alone.
 */
export function hubChatIdentity(sessionId: string, lookups: HubChatLookups): HubChatIdentity {
  const own = lookups.monoOf(sessionId)?.id;
  if (own) {
    const role = monoRole(own, lookups);
    return { kind: "mono", chat: sessionId, monoId: own, role, ...projectsOf(own, role, lookups) };
  }
  const habit = lookups.habitRunMono(sessionId);
  if (habit) {
    const role = monoRole(habit, lookups);
    return { kind: "habit", chat: sessionId, monoId: habit, role, ...projectsOf(habit, role, lookups) };
  }
  if (sessionId.startsWith("app-")) {
    const root = rootOwnerChat(sessionId, lookups);
    const parent = root ? hubChatIdentity(root, lookups) : undefined;
    return { kind: "worker", chat: sessionId, role: "worker", ...(parent?.projects ? { projects: parent.projects } : {}) };
  }
  const team = lookups.codingTeamProject?.(sessionId);
  if (team) return { kind: "team", chat: sessionId, projects: [team] };
  return { kind: "chat", chat: sessionId };
}

/**
 * The Mono a chat belongs to: its own chat, one of its habit runs, or a worker started under one of those (however
 * deep). A coding-team chat, a plain hub chat or the app's own helper processes belong to no Mono. Uses the lookups
 * the hub registered; none registered, none known.
 */
export function chatMonoOwner(sessionId: string, lookups: HubChatLookups | undefined = registered?.lookups): string | undefined {
  if (!lookups) return undefined;
  const own = lookups.monoOf(sessionId)?.id;
  if (own) return own;
  const habit = lookups.habitRunMono(sessionId);
  if (habit) return habit;
  if (!sessionId.startsWith("app-")) return undefined;
  const root = rootOwnerChat(sessionId, lookups);
  return root ? chatMonoOwner(root, lookups) : undefined;
}

/**
 * What kind of run a chat is, for words Ash reads (the soul tamper row): a Mono's own chat, a habit run, or a worker
 * (`app-<chat>-<request>`, started by a chat at any depth). Anything else (a plain chat) is a chat.
 */
export function chatRunKind(sessionId: string, lookups: HubChatLookups | undefined = registered?.lookups): "chat" | "habit" | "worker" {
  if (lookups?.monoOf(sessionId)) return "chat";
  if (lookups?.habitRunMono(sessionId)) return "habit";
  return sessionId.startsWith("app-") ? "worker" : "chat";
}

/**
 * Whether this chat gets the delegate tool: the chats Ash talks to, a Mono's own chat (not the checker's: it only
 * reads) and a coding-team chat.
 */
/**
 * Claude Code's own worktree tools, which the app keeps from every chat it runs for a Mono, a coding team or a worker.
 * The app owns worktrees there: a worker is started in the checkout the delegate tool made for it (isolation
 * "worktree"). Run dd7f, 27 Oct: Tally's Lead called EnterWorktree, made .claude/worktrees/readme-truth and briefed
 * its worker to commit there, so the worker's own checkout under tally-worktrees/ sat empty and the app tracked
 * the wrong folder. Ash's own plain chats keep the tools.
 */
export const HUB_WORKTREE_DENIED_TOOLS = ["EnterWorktree", "ExitWorktree"];

/**
 * r77 (blind c02): a coding-team chat ran \`git worktree add ../tally-health-board\` and did the work there, beside the
 * project and outside the app's view. A coding-team chat and a worker never make a worktree by hand; delegate_task's
 * isolation "worktree" is how one is made.
 */
export const HAND_WORKTREE_DENIED_TOOLS = ["Bash(git worktree add:*)"];

export function worktreeDeniedTools(identity: HubChatIdentity): string[] {
  if (identity.kind === "chat") return [];
  return identity.kind === "team" || identity.kind === "worker" ? [...HUB_WORKTREE_DENIED_TOOLS, ...HAND_WORKTREE_DENIED_TOOLS] : HUB_WORKTREE_DENIED_TOOLS;
}

/**
 * A chat that hands out work saves Ash's standing rules with ash_remember, never by rewriting Claude Code's own settings
 * or hooks: in blind c02 (r78) a coding-team chat reached for the update-config skill to make "from now on run npm
 * test" a hook, and its Allow card held the whole turn for three minutes before any worker started. Refused at once,
 * the chat goes straight on to its jobs.
 */
export const ORCHESTRATOR_DENIED_TOOLS = ["Skill(update-config)"];

export function getsDelegateTool(identity: HubChatIdentity): boolean {
  return (identity.kind === "mono" && identity.role !== "checker") || identity.kind === "team";
}

/**
 * WP-255: whether this chat may get computer use at all: the chats Ash talks to (a Mono's own chat, a coding-team chat,
 * a plain chat). Never a worker or a habit run, which run with nobody watching, and never the checker, which only reads.
 * Settings > Computer use and the chat's own say decide the rest (computerUse.ts).
 */
export function getsComputerUse(identity: HubChatIdentity): boolean {
  if (identity.kind === "mono") return identity.role !== "checker";
  return identity.kind === "team" || identity.kind === "chat";
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
  /** This app's executable, or null when it couldn't be read. */
  cli: string | null;
  /** A Mono's connector entries (hubConnectors.connectorServersForMono); none when absent. */
  connectors?: (monoId: string) => Record<string, unknown>;
};

/**
 * The extra Claude Code arguments for one chat: one --mcp-config, plus the delegate tool's approval, plus the fence
 * round the Monos' home.
 */
export function hubMcpArgs(
  sessionId: string,
  servers: HubMcpServers,
  lookups: HubChatLookups,
): string[] {
  const identity = hubChatIdentity(sessionId, lookups);
  // The checker only reads, whatever else this chat gets (its deny list carries the fence round the Monos' home too).
  const restrict = identity.role === "checker" ? checkerToolArgs() : [];
  const delegate = !!servers.cli && getsDelegateTool(identity);
  // Every other chat is fenced out of the Monos' home: last, so a chat's own arguments read as they always have.
  const fence =
    identity.role === "checker"
      ? []
      : [
          "--disallowedTools",
          [...chatDeniedTools(), ...worktreeDeniedTools(identity), ...(delegate ? ORCHESTRATOR_DENIED_TOOLS : [])].join(","),
        ];
  const mcpServers: Record<string, unknown> = {};
  // A Mono's connectors go in first, so the hub's own entries below always keep their names.
  if (servers.connectors && identity.monoId && (identity.kind === "mono" || identity.kind === "habit"))
    Object.assign(mcpServers, servers.connectors(identity.monoId));
  if (delegate) mcpServers.monocode = monocodeServer(servers.cli!);
  // Not pre-approved: Claude Code asks before each computer-use call unless the chat runs with full access.
  const computerUse = knownComputerUse();
  if (servers.cli && getsComputerUse(identity) && computerUse && chatGetsComputerUse(computerUse, sessionId))
    mcpServers.computer = computerUseServer(servers.cli, sessionId, computerUse.settingsPath);
  if (!Object.keys(mcpServers).length) return [...restrict, ...fence];
  return [
    ...restrict,
    ...(delegate ? ["--allowedTools", delegateAllowedTools()] : []),
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    ...fence,
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

/** The fence round the Monos' home as Claude Code arguments: every Claude process the app starts carries it. */
export function monoHomeFenceArgs(): string[] {
  return ["--disallowedTools", chatDeniedTools().join(",")];
}

/** The app's own helper Claude processes (titles, commit text, the room's gate, the catalog probe) carry the fence too. */
export function registerClaudeGuards(): void {
  setClaudeGuardArgs(monoHomeFenceArgs);
}

/**
 * The registered servers' arguments for a chat (the seam's provider). Before they are read (or if reading them timed
 * out) a chat still gets the fence: only the servers wait, never the guard.
 */
export function registeredHubMcpArgs(sessionId: string): string[] {
  return registered ? hubMcpArgs(sessionId, registered.servers, registered.lookups) : monoHomeFenceArgs();
}

/**
 * Whether this chat's session has the delegate tool, so its context can teach it (monoFiles.ts
 * `<delegate_rules>`). WP-120: any CLI in the lead table, not only Claude Code. A CLI that cannot
 * lead is a no, and the chat says why (leadBlockReason).
 */
export function hasDelegateTool(sessionId: string, harness: string): boolean {
  if (!canLead(harness) || !registered?.servers.cli) return false;
  return getsDelegateTool(hubChatIdentity(sessionId, registered.lookups));
}

/**
 * Codex config for the same chats. Empty unless this chat leads and the app CLI is known.
 * The connection is only the names MONOCODE_APP_ENDPOINT and MONOCODE_APP_TOKEN in env_vars, never a token value.
 */
export function registeredCodexLeadConfig(sessionId: string): Record<string, unknown> {
  const cli = registered?.servers.cli;
  if (!cli || !registered) return {};
  if (!getsDelegateTool(hubChatIdentity(sessionId, registered.lookups))) return {};
  return { mcp_servers: { monocode: codexLeadServer(cli) } };
}

/**
 * The projects a chat works on: a Lead's chat, its habit runs and its workers get their Lead's
 * project, a coding-team chat and its workers that team's project; anyone else none. What its memory primer
 * (hubMemoryPrimer.ts) and its workers' briefs are about.
 */
export function chatProjects(sessionId: string): string[] {
  return registered ? (hubChatIdentity(sessionId, registered.lookups).projects ?? []) : [];
}

