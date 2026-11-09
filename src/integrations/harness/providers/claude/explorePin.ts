/**
 * WP-143: Claude Code's built-in Explore runs on the session model unless a
 * project agent file sets `model`. A hub-launched Claude session gets
 * `.claude/agents/Explore.md` and `.claude/agents/Plan.md` in that session's
 * folder when the file is missing. An existing file is left alone, whatever
 * it says. Nothing is written under the user's own `.claude` directory.
 *
 * Other CLIs are unchanged. Off Anthropic, Claude Code already receives
 * CLAUDE_CODE_SUBAGENT_MODEL from subagentModelEnv (claudeProtocol.ts) and
 * from the router (model_router.rs). Those variables stay as they are. This
 * file is the named agent pin they do not replace.
 */

export const EXPLORE_PIN_FILE = ".claude/agents/Explore.md";
export const PLAN_PIN_FILE = ".claude/agents/Plan.md";

/** Shown when this launch created the Explore file on Haiku. */
export const EXPLORE_PIN_SENTENCE =
  "Explore uses Haiku so the lead model is not spent on search.";

/** Shown when this launch created the Explore file on the worker's own model. */
export const EXPLORE_PIN_OTHER_SENTENCE =
  "Explore uses this worker's model so the lead model is not spent on search.";

const SAFE_MODEL = /^[A-Za-z0-9._-]{1,120}$/;

export type ExplorePinFile = {
  relative: typeof EXPLORE_PIN_FILE | typeof PLAN_PIN_FILE;
  content: string;
};

/**
 * Reads and creates agent files. `create` must not overwrite a file that
 * already exists, and must not write outside `cwd` or into the user's
 * `.claude` directory. A throw is a missed pin, not a failed launch.
 */
export type ExplorePinIo = {
  read(absolutePath: string): Promise<string | null>;
  create(cwd: string, files: ExplorePinFile[]): Promise<string[]>;
};

export type ExplorePinResult = {
  created: string[];
  sentence?: string;
};

/**
 * Haiku when the session is on Anthropic (`offAnthropicModel` empty).
 * The worker's own model id otherwise. An id that would break the file
 * is refused, and Haiku is not written in its place.
 */
export function explorePinModel(offAnthropicModel: string | undefined): string | undefined {
  const own = offAnthropicModel?.trim() ?? "";
  if (!own) return "haiku";
  return SAFE_MODEL.test(own) ? own : undefined;
}

/** The agent file. The model field is always a single plain line. */
export function exploreAgentFile(name: "Explore" | "Plan", model: string): string {
  if (!SAFE_MODEL.test(model)) {
    throw new Error("Explore pin model is not a plain model id.");
  }
  const description =
    name === "Explore"
      ? "Read-only search of this project. Use this to find files and answer questions about the code."
      : "Read-only planning for this project. Use this to design an approach before any edits.";
  const body =
    name === "Explore"
      ? "Search and read only. Do not edit files, and do not change the project."
      : "Plan only. Do not edit files, and do not change the project.";
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "tools: Read, Grep, Glob, Bash",
    `model: ${model}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function withSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathParts(path: string): string[] {
  return withSlashes(path).split("/").filter((part) => part.length > 0 && part !== ".");
}

function isAbsolutePath(path: string): boolean {
  const slashed = withSlashes(path);
  return slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed);
}

/**
 * True when `cwd` is the user's `.claude` directory or sits inside it.
 * Compared case-insensitively so a differently cased copy still counts.
 */
export function isUserClaudeDir(cwd: string, home: string | undefined): boolean {
  const root = home?.trim();
  if (!root) return false;
  const marker = [...pathParts(root), ".claude"];
  const got = pathParts(cwd);
  if (got.length < marker.length) return false;
  return marker.every((part, index) => part.toLowerCase() === got[index]?.toLowerCase());
}

/** A session folder this pin is willing to write into. */
export function explorePinAllowed(cwd: string, home?: string): boolean {
  const raw = cwd?.trim() ?? "";
  if (!raw || raw.includes("\0") || raw.startsWith("remote://")) return false;
  if (!isAbsolutePath(raw)) return false;
  if (withSlashes(raw).split("/").includes("..")) return false;
  if (pathParts(raw).some((part) => part.toLowerCase() === ".claude")) return false;
  if (isUserClaudeDir(raw, home)) return false;
  // Writing `.claude` into the home folder would create the user's own Claude directory.
  if (wouldCreateUserClaude(raw, home)) return false;
  return true;
}

/** True when `cwd/.claude` is the user's `.claude` directory. */
function wouldCreateUserClaude(cwd: string, home: string | undefined): boolean {
  const root = home?.trim();
  if (!root) return false;
  const marker = [...pathParts(root), ".claude"];
  const dest = [...pathParts(cwd), ".claude"];
  if (dest.length < marker.length) return false;
  return marker.every((part, index) => part.toLowerCase() === dest[index]?.toLowerCase());
}

export function explorePinPath(cwd: string, relative: string): string | undefined {
  if (relative !== EXPLORE_PIN_FILE && relative !== PLAN_PIN_FILE) return undefined;
  if (!explorePinAllowed(cwd)) return undefined;
  const base = cwd.replace(/[\\/]+$/, "");
  return `${base}/${relative}`;
}

export function explorePinFiles(model: string): ExplorePinFile[] {
  return (["Explore", "Plan"] as const).map((name) => ({
    relative: name === "Explore" ? EXPLORE_PIN_FILE : PLAN_PIN_FILE,
    content: exploreAgentFile(name, model),
  }));
}

export function explorePinSentence(model: string, created: readonly string[]): string | undefined {
  if (!created.includes(EXPLORE_PIN_FILE)) return undefined;
  return model === "haiku" ? EXPLORE_PIN_SENTENCE : EXPLORE_PIN_OTHER_SENTENCE;
}

let injected: ExplorePinIo | undefined;

/** Tests inject the folder access. The app uses its own when this is unset. */
export function setExplorePinIo(io: ExplorePinIo | undefined): void {
  injected = io;
}

async function defaultIo(): Promise<ExplorePinIo | undefined> {
  try {
    const internals = (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window
      ?.__TAURI_INTERNALS__;
    if (!internals) return undefined;
    const { invoke } = await import("@tauri-apps/api/core");
    return {
      async read(absolutePath) {
        try {
          return await invoke<string>("read_text_file", { path: absolutePath });
        } catch {
          return null;
        }
      },
      create(cwd, files) {
        return invoke<string[]>("ensure_cheap_explore_pin", { cwd, files });
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Create the missing agent files for one launch. An existing file is left
 * alone. A read or write problem returns no sentence and does not throw.
 */
export async function ensureCheapExplorePin(input: {
  cwd: string;
  offAnthropicModel?: string;
  home?: string;
  io?: ExplorePinIo;
}): Promise<ExplorePinResult> {
  try {
    return await writeCheapExplorePin(input);
  } catch {
    return { created: [] };
  }
}

async function writeCheapExplorePin(input: {
  cwd: string;
  offAnthropicModel?: string;
  home?: string;
  io?: ExplorePinIo;
}): Promise<ExplorePinResult> {
  const none: ExplorePinResult = { created: [] };
  const model = explorePinModel(input.offAnthropicModel);
  if (!model || !explorePinAllowed(input.cwd, input.home)) return none;
  const io = input.io ?? injected ?? (await defaultIo());
  if (!io) return none;
  const missing: ExplorePinFile[] = [];
  for (const file of explorePinFiles(model)) {
    const absolute = explorePinPath(input.cwd, file.relative);
    if (!absolute) return none;
    let existing: string | null;
    try {
      existing = await io.read(absolute);
    } catch {
      // A failed read is not proof the file is missing. Leave it alone.
      continue;
    }
    if (existing === null) missing.push(file);
  }
  if (missing.length === 0) return none;
  try {
    const written = await io.create(input.cwd, missing);
    const created = written.filter((name) => missing.some((file) => file.relative === name));
    return { created, sentence: explorePinSentence(model, created) };
  } catch {
    return none;
  }
}
