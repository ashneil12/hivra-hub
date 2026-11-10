/**
 * WP-143: Claude Code's built-in Explore runs on the session model unless an Explore agent names a cheaper one.
 * A hub crew or Mono session on Anthropic gets one as Claude Code's `--agents` flag, on that session's own process.
 *
 * Nothing is written into the folder the session works in. The first build wrote `.claude/agents/Explore.md` and
 * `Plan.md` there, which dirtied every worktree, blocked ship and worktree removal, and was committed by crews.
 *
 * - Only crew and Mono sessions (features/crew/model/crewSession.ts), and only on Anthropic. A session on the
 *   DeepSeek launcher or a routed Other model already runs its sub-agents on its own model (subagentModelEnv in
 *   claudeProtocol.ts), and an ordinary chat in someone's own project is left exactly as it was.
 * - Never shadows an Explore the person defined. `--agents` outranks `.claude/agents`, so an Explore at the user or
 *   project level (src-tauri/src/explore_agent.rs reads that) means the flag is not passed. The same check keeps the
 *   flag off a session whose environment selects Bedrock, Vertex, Foundry or another API base URL.
 * - Plan stays on the session model.
 *
 * `subagentModelEnv` is unchanged. Other CLIs get their sub-agent model from the environment and are not touched.
 */

import { compareSemver, parseClaudeVersion } from "./claudeProtocol";

/** Shown once a launch passed the flag. A keyed status line, so a restart replaces it instead of repeating it. */
export const EXPLORE_PIN_SENTENCE =
  "Explore uses Haiku so the lead model is not spent on search.";

const EXPLORE_AGENT = {
  Explore: {
    description:
      "Read-only search of this project. Use this to find files and answer questions about the code.",
    prompt: "Search and read only. Do not edit files, and do not change the project.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "haiku",
  },
};

/** The `--agents` value: one Explore agent, no Plan. */
export function exploreAgentsArg(): string {
  return JSON.stringify(EXPLORE_AGENT);
}

export function exploreAgentsArgs(): string[] {
  return ["--agents", exploreAgentsArg()];
}

/**
 * True when the session must start without the flag: an Explore agent is already defined for it in `cwd` (user level
 * or project level), the environment selects Bedrock, Vertex, Foundry or another API base URL, or that can't be told.
 * A throw means the same as true.
 */
export type ExploreLookup = (input: {
  cwd: string;
  providerAccountId?: string;
  /** The folders the session adds with `--add-dir`. A relative one is relative to `cwd`. */
  addDirs: string[];
}) => Promise<boolean>;

let injected: ExploreLookup | undefined;

/** Tests inject the lookup. The app uses its own when this is unset. */
export function setExploreLookup(lookup: ExploreLookup | undefined): void {
  injected = lookup;
}

async function appLookup(): Promise<ExploreLookup | undefined> {
  try {
    const internals = (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window
      ?.__TAURI_INTERNALS__;
    if (!internals) return undefined;
    const { invoke } = await import("@tauri-apps/api/core");
    return (input) =>
      invoke<boolean>("claude_explore_agent_defined", {
        cwd: input.cwd,
        providerAccountId: input.providerAccountId ?? null,
        addDirs: input.addDirs,
      });
  } catch {
    return undefined;
  }
}

/** A folder the lookup can answer for: a local, absolute path with no `..`. */
function lookable(cwd: string): boolean {
  const raw = cwd.trim();
  if (!raw || raw.includes("\0") || raw.startsWith("remote://")) return false;
  const slashed = raw.replace(/\\/g, "/");
  if (!slashed.startsWith("/") && !/^[A-Za-z]:\//.test(slashed)) return false;
  return !slashed.split("/").includes("..");
}

export type CheapExploreLaunch = { args: string[]; sentence?: string };

/**
 * The folders a launch adds with `--add-dir`: one or several after the flag (it takes a list, up to the next option),
 * or `--add-dir=<folder>`. The app adds none of its own today; a plugin or the hub's extra arguments may.
 */
export function addDirsOf(args: readonly string[]): string[] {
  const dirs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--add-dir") {
      while (index + 1 < args.length && !args[index + 1].startsWith("-")) {
        index += 1;
        if (args[index]) dirs.push(args[index]);
      }
    } else if (arg.startsWith("--add-dir=") && arg.length > "--add-dir=".length) {
      dirs.push(arg.slice("--add-dir=".length));
    }
  }
  return dirs;
}

/** Claude Code 2.0.0 added `--agents` (its changelog: "Add subagents dynamically with `--agents` flag"). */
export const AGENTS_FLAG_MIN_VERSION = "2.0.0";

/** How a launch reads the CLI's version: `key` names the binary (its path), `version` returns `--version` output. */
export type ClaudeCliVersion = { key: string; version: () => Promise<string> };

const agentsFlagByCli = new Map<string, boolean>();

/** Tests: forget what was learned about each CLI. */
export function resetAgentsFlagCache(): void {
  agentsFlagByCli.clear();
}

/**
 * Whether this CLI knows `--agents`. An older one exits on an unknown option, which would fail every crew and Mono
 * launch, so a version that can't be read or understood means no. Asked once per binary; an answer that was not
 * obtained is not remembered, so the next launch asks again.
 */
async function cliHasAgentsFlag(cli: ClaudeCliVersion | undefined): Promise<boolean> {
  if (!cli) return false;
  const known = agentsFlagByCli.get(cli.key);
  if (known !== undefined) return known;
  const version = parseClaudeVersion(await within(cli.version(), EXPLORE_LOOKUP_MS));
  if (!version) return false;
  const has = compareSemver(version, AGENTS_FLAG_MIN_VERSION) >= 0;
  agentsFlagByCli.set(cli.key, has);
  return has;
}

/** How long a launch waits to learn whether an Explore is defined. A slow answer is a missed pin, not a stuck chat. */
export const EXPLORE_LOOKUP_MS = 3000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The Explore lookup took too long.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The extra arguments for one new Claude process, and the line to show. Empty unless this is a crew or Mono session
 * on Anthropic, in a folder that can be checked, with no Explore of the person's own, on a CLI that knows the flag.
 * The line is for the caller to show once the process has started. Never throws.
 */
export async function cheapExploreLaunch(input: {
  crew: boolean;
  anthropic: boolean;
  cwd: string;
  providerAccountId?: string;
  /** What the launch passes as `--add-dir` (`addDirsOf`). */
  addDirs?: string[];
  /** How to read the CLI's version. Without it the flag is not passed. */
  cli?: ClaudeCliVersion;
  lookup?: ExploreLookup;
}): Promise<CheapExploreLaunch> {
  const none: CheapExploreLaunch = { args: [] };
  if (!input.crew || !input.anthropic || !lookable(input.cwd)) return none;
  try {
    const lookup = input.lookup ?? injected ?? (await appLookup());
    if (!lookup) return none;
    const defined = await within(
      lookup({ cwd: input.cwd, providerAccountId: input.providerAccountId, addDirs: input.addDirs ?? [] }),
      EXPLORE_LOOKUP_MS,
    );
    if (defined) return none;
    if (!(await cliHasAgentsFlag(input.cli))) return none;
    return { args: exploreAgentsArgs(), sentence: EXPLORE_PIN_SENTENCE };
  } catch {
    return none;
  }
}
