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
export type ExploreLookup = (input: { cwd: string; providerAccountId?: string }) => Promise<boolean>;

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
 * on Anthropic, in a folder that can be checked, with no Explore of the person's own. Never throws.
 */
export async function cheapExploreLaunch(input: {
  crew: boolean;
  anthropic: boolean;
  cwd: string;
  providerAccountId?: string;
  lookup?: ExploreLookup;
}): Promise<CheapExploreLaunch> {
  const none: CheapExploreLaunch = { args: [] };
  if (!input.crew || !input.anthropic || !lookable(input.cwd)) return none;
  try {
    const lookup = input.lookup ?? injected ?? (await appLookup());
    if (!lookup) return none;
    const defined = await within(
      lookup({ cwd: input.cwd, providerAccountId: input.providerAccountId }),
      EXPLORE_LOOKUP_MS,
    );
    if (defined) return none;
    return { args: exploreAgentsArgs(), sentence: EXPLORE_PIN_SENTENCE };
  } catch {
    return none;
  }
}
