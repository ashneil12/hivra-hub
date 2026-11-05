// This copy's project memory, the same root Rust uses (portable.rs `Env::for_app`):
// `MONOCODE_HUB_MEMORY_ROOT` when set, else a dev copy's `<data>/agent-memory`, else `<HOME>/agent-memory`.
// HOME is the process home (`dirs_home`), so a temp-HOME bench is the temp folder, never a guessed /Users/<name>.
// Prompts name that folder in full. A model expands "~" itself, and it expands it to the real user.
import { isEqualOrInside, joinPath, slash } from "../../../shared/lib/paths";
import { forUser } from "./userName";

export type MemoryLayout = {
  kind: "daily" | "dev";
  /** This process's HOME. */
  home?: string;
  /** The app data folder. A dev copy keeps memory here when no override is set. */
  dataDir?: string;
  /** `MONOCODE_HUB_MEMORY_ROOT`. Wins when it is an absolute path. */
  override?: string;
};

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** An absolute path with no `~` and no `..` segment, or undefined. */
export function absoluteMemoryPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = slash(value).replace(/\r/g, "").trim().replace(/[\\/]+$/, "");
  if (!clean || clean.includes("~") || clean.split("/").includes("..")) return undefined;
  if (clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) return clean;
  return undefined;
}

/**
 * The memory root for one layout. Matches portable.rs: the override, else a dev copy's data folder, else HOME.
 * A dev copy with neither an override nor a data folder does not fall back to HOME/agent-memory (that is the daily app's).
 */
export function resolveAgentMemoryRoot(layout: MemoryLayout): string | undefined {
  const override = absoluteMemoryPath(layout.override);
  if (override) return override;
  if (layout.kind === "dev") {
    const data = absoluteMemoryPath(layout.dataDir);
    return data ? joinPath(data, "agent-memory") : undefined;
  }
  const home = absoluteMemoryPath(layout.home);
  return home ? joinPath(home, "agent-memory") : undefined;
}

let root: string | undefined;
/** The real bench's chats have ash_recall and ash_remember (scripts/hub-realtest-claude.mjs). The app's own chats do not. */
let tools = false;

/** Record the root `portable_info` reported. Anything that is not an absolute path is ignored. */
export function setAgentMemoryRoot(path: string | undefined): void {
  root = absoluteMemoryPath(path);
}

export function agentMemoryRoot(): string | undefined {
  return root;
}

export function setMemoryTools(on: boolean): void {
  tools = on;
}

export function memoryTools(): boolean {
  return tools;
}

export function resetAgentMemoryForTests(): void {
  root = undefined;
  tools = false;
}

/** A project id safe to join onto the root, or "this project" when it is not. */
export function projectLabel(project: string): string {
  return PROJECT.test(project) ? project : "this project";
}

/**
 * The project's folder and Ash's global folder. A directory from a primer is used only when it is absolute and, once
 * this copy's root is known, inside that root. A tilde, a relative path or `..` never wins.
 */
export function projectMemoryDirs(
  project: string,
  given?: { memory_dir?: string; global_dir?: string },
): { project?: string; ash?: string } {
  const segment = PROJECT.test(project) ? project : undefined;
  const fallbackProject = root && segment ? joinPath(root, segment) : undefined;
  const fallbackAsh = root ? joinPath(root, "ash") : undefined;
  return {
    project: trustedDir(given?.memory_dir, fallbackProject),
    ash: trustedDir(given?.global_dir, fallbackAsh),
  };
}

function trustedDir(given: string | undefined, fallback: string | undefined): string | undefined {
  const abs = absoluteMemoryPath(given);
  if (!abs) return fallback;
  if (root && !isEqualOrInside(abs, root)) return fallback;
  return abs;
}

/** The read line. With the memory tool, the tool's name comes before the path. */
export function readMemorySentence(project: string, dirs: { project?: string; ash?: string }): string {
  const id = projectLabel(project);
  const files = dirs.project && dirs.ash ? `${dirs.project}/MEMORY.md and ${dirs.ash}/MEMORY.md` : undefined;
  if (tools) return files ? `Before you act, call ash_recall for ${id}. The files are ${files}.` : `Before you act, call ash_recall for ${id}.`;
  return files ? `Before you act, read ${id}'s memory: ${files}.` : `Before you act, read ${id}'s memory.`;
}

/** Where to read the rest. With the memory tool, the tool's name comes before the path. */
export function moreMemoryLead(dirs: { project?: string }): string {
  const where = dirs.project ? `in ${dirs.project}` : "in this project's memory";
  return tools
    ? `For more, call ash_recall, then read never.md and decisions.md ${where}.`
    : `For more, read never.md and decisions.md ${where}.`;
}

/**
 * The Lead's save line. "Ash" sits in the template text so a renamed install swaps it; the file path is interpolated, so a
 * folder that happens to contain that name is left alone. With the memory tool, ash_remember comes before the file.
 */
export function primerSaveClause(project: string, dirs: { project?: string; ash?: string }): string {
  const id = projectLabel(project);
  const file = dirs.project ? `${dirs.project}/decisions.md` : "decisions.md";
  if (tools) {
    const files = dirs.ash
      ? forUser` The file is ${file} (${`${dirs.ash}/decisions.md`} for every project).`
      : forUser` The file is ${file} (Ash's decisions.md for every project).`;
    return forUser` Call ash_remember first when Ash makes a call (project ${id}, or ash only for how Ash works in every project): he answers a question you asked him, or says remember, lock or from now on.${files} A half-made or contested thought stays unsaved.`;
  }
  const only = dirs.ash
    ? forUser`(${`${dirs.ash}/`} only for how Ash works in every project)`
    : forUser`(Ash's global memory only for how Ash works in every project)`;
  return forUser` Save to ${file} at once when Ash makes a call: he answers a question you asked him, or says remember, lock or from now on ${only}. A half-made or contested thought stays unsaved.`;
}
