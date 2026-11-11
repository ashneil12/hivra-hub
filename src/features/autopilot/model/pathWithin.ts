// Path checks with no imports from the app. The Claude folder pin imports this file, and the host bundle loads that
// pin. Importing these checks from safeApproval pulls plugin and hub modules into the host bundle and into the phone
// session list.

/** A drive path, C:\ or C:/ (round 7, Windows CI). */
export const DRIVE = /^[a-z]:[\\/]/i;

/**
 * Whether a folder's file system ignores case: Windows (a drive or a UNC share) and the Mac's own folders (/Users, /Volumes,
 * /private). Elsewhere names are compared as written (round 7, Windows CI).
 */
export function ignoresCase(folder: string): boolean {
  return DRIVE.test(folder) || /^\\\\|^\/\//.test(folder) || /^\/(users|volumes|private)\//i.test(folder);
}

/**
 * A path as a containment check compares it (round 7, Windows CI): forward slashes, a verbatim `\\?\` prefix gone, repeated
 * and trailing slashes gone, and case folded where the file system ignores case.
 */
export function comparablePath(path: string, caseless: boolean, windows = false): string {
  // Round 8: a backslash becomes a separator only for a Windows path; on a Mac it is part of a name and stays one.
  const stripped = path.replace(/^(\\\\\?\\|\/\/\?\/)/, "");
  const text = (windows ? stripped.replace(/\\/g, "/") : stripped)
    .replace(/\/+/g, "/")
    .replace(/(.)\/$/, "$1");
  return caseless ? text.toLowerCase() : text;
}

/** Whether a path is a Windows path: a drive (C:\ or C:/) or a UNC share (\\server). Round 8: only these read \ as a separator. */
export function windowsShaped(path: string): boolean {
  return DRIVE.test(path) || /^\\\\/.test(path);
}

/**
 * Whether `real` is `folder` or inside it, compared by whole path components, never by a string prefix (so `chat2` is not
 * inside `chat`). Both sides are read the same way, whatever their separators. `windows` says which reading of a backslash
 * applies; by default a Windows path (a drive or a UNC share) on either side reads it as a separator, and nothing else does.
 */
export function pathWithin(
  real: string,
  folder: string,
  caseless = ignoresCase(folder),
  windows = windowsShaped(folder),
): boolean {
  const r = lexicalParts(comparablePath(real, caseless, windows));
  const f = lexicalParts(comparablePath(folder, caseless, windows));
  return !!r && !!f && r.length >= f.length && f.every((part, i) => r[i] === part);
}

/**
 * The parts of a comparable path with `.` and `..` taken by words (round 8): a `..` after a name goes up one name. A climb
 * past the root is null, so the path is never inside anything. A root (`/` or a drive) is the first part and can't be climbed.
 */
function lexicalParts(text: string): string[] | null {
  const parts = text.split("/");
  const rooted = parts[0] === "" || /^[a-z]:$/i.test(parts[0]);
  const out: string[] = rooted ? [parts[0]] : [];
  for (const part of rooted ? parts.slice(1) : parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length <= (rooted ? 1 : 0)) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}
