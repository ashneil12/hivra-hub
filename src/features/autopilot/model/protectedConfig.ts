// The agent and tool configs autopilot never edits, and the dot-named folders it never edits inside (WP-101 review round
// 3, item 1). The names come from src/shared/security/agentConfigPaths.json, which the Rust timer check reads too
// (src-tauri/src/watcher/safe_cmd.rs), so the two lists cannot drift. Names are compared the way a Mac and Windows
// compare them: NFKC, the long s folded to s, invisible characters gone, lower case, and trailing dots and spaces
// stripped per segment (`.codex.` is `.codex`).
import list from "../../../shared/security/agentConfigPaths.json";

type ProtectedList = {
  version: number;
  files: string[];
  dirs: string[];
  pathSuffixes: string[];
  /** Folder runs that hold anywhere in a path (`src/shared/security`): the guard's own source (round 4, item 8). */
  pathSequences: string[];
  holdAnyDotSegment: boolean;
};

const LIST = list as ProtectedList;

/** One segment as the file system compares it. "." and ".." are never passed here: they are resolved first. */
export function foldSegment(part: string): string {
  return part
    .normalize("NFKC")
    .replace(/ſ/g, "s")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/(?<=[^. ])[. ]+$/, "");
}

const FILES = new Set(LIST.files.map(foldSegment));
const DIRS = new Set(LIST.dirs.map(foldSegment));
const SUFFIXES: readonly (readonly string[])[] = LIST.pathSuffixes.map((suffix) => suffix.split("/").map(foldSegment));
const SEQUENCES: readonly (readonly string[])[] = LIST.pathSequences.map((run) => run.split("/").map(foldSegment));

/** A dot-named segment, as the list counts one: any start with "." other than "." and "..". */
function dotSegment(part: string): boolean {
  const text = part.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
  return text.startsWith(".") && text !== "." && text !== "..";
}

const endsWith = (parts: readonly string[], suffix: readonly string[]) =>
  suffix.length <= parts.length && suffix.every((part, i) => parts[parts.length - suffix.length + i] === part);

/** Whether a run of segments appears anywhere in the path, in order. */
const holdsRun = (parts: readonly string[], run: readonly string[]) =>
  parts.some((_, start) => run.every((part, i) => parts[start + i] === part));

/**
 * Whether a path, given as its segments under the chat's folder, is a protected config: a dot-named segment (any folder
 * or file the tools read skills and settings from), a folder in the list, a file in the list, a listed suffix, or a run of
 * folders the guard lives in (`pathSequences`, held for an edit only). `dotSegments` is off for a read command's words: a
 * read of the chat's own dot-named file is ordinary (`cat ./.zshrc` is allowed), and only the named config list holds it.
 * Edits hold every dot-named segment.
 */
export function isProtectedConfig(parts: readonly string[], dotSegments = true): boolean {
  if (!parts.length) return false;
  if (dotSegments && LIST.holdAnyDotSegment && parts.some(dotSegment)) return true;
  const folded = parts.map(foldSegment);
  if (folded.some((part) => DIRS.has(part))) return true;
  if (FILES.has(folded[folded.length - 1])) return true;
  // The guard's own source is held for an edit only (dotSegments true): a read of it is ordinary (round 4, item 8).
  if (dotSegments && SEQUENCES.some((run) => holdsRun(folded, run))) return true;
  return SUFFIXES.some((suffix) => endsWith(folded, suffix));
}

/** The segments of a path as written, either slash. */
export function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/);
}
