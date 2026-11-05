// How the behaviour bench answers a permission card (docs/REALCONV.md). One rule, the way Ash would:
// allow a Read whose every path sits inside the bench's temporary HOME, the test project's folder, or that
// Mono's memory folder, and refuse anything else. Paths are resolved lexically (`.` and `..` only). A symlink
// is never followed, and a path that is a link, or has a link on the way, is refused.

/** A root shallower than this (`/` or `/tmp`) is too broad to allow a read inside. */
const MIN_ROOT_DEPTH = 2;

/** `..` and `.` resolved on a POSIX path. Null when it isn't absolute or it climbs past `/`. */
function lexicalPosix(abs) {
  if (typeof abs !== "string" || !abs.startsWith("/")) return null;
  const parts = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A root the rule may allow a read inside, or null when it is missing or too broad. */
function usableRoot(root) {
  const lexical = lexicalPosix(String(root ?? "").replace(/\/+$/, "") || "/");
  if (!lexical) return null;
  if (lexical.split("/").filter(Boolean).length < MIN_ROOT_DEPTH) return null;
  return lexical;
}

/** True when `file` is the root or a file inside it, and not a longer name that only starts the same (`/tmp/home-evil`). */
function inside(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

/** The path, then each folder on the way up to `/`. */
function ancestors(file) {
  const parts = file.split("/").filter(Boolean);
  const out = [];
  for (let i = parts.length; i >= 1; i -= 1) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

function badPath(text) {
  return (
    typeof text !== "string" ||
    !text.trim() ||
    text.includes("\0") ||
    text.includes("\r") ||
    text.includes("\n") ||
    text.includes("->") ||
    text.includes("\\") ||
    /^[A-Za-z]:/.test(text)
  );
}

/**
 * Allow or refuse one permission ask.
 * `ask.paths` are the files the tool named. A relative path is resolved against `cwd` (the chat's folder);
 * with no cwd it is refused. `isSymlink(abs)`, when given, is asked about the path and every folder above it
 * and is not followed: true refuses the ask.
 * Returns `{ allow, decision: "allow"|"refuse", path }` where `path` is the first path, else the command, else `(no path)`.
 */
export function permissionDecision(ask, roots, { cwd = null, isSymlink = null } = {}) {
  const paths = Array.isArray(ask?.paths) ? ask.paths.filter((p) => typeof p === "string") : [];
  const pathText = paths[0] || (typeof ask?.command === "string" && ask.command.trim() ? ask.command : "(no path)");
  const refuse = () => ({ allow: false, decision: "refuse", path: pathText });
  if (String(ask?.tool ?? "").toLowerCase() !== "read") return refuse();
  if (!paths.length || paths.some(badPath)) return refuse();
  const allowed = [roots?.home, roots?.project, roots?.memory].map(usableRoot).filter(Boolean);
  if (!allowed.length) return refuse();
  const base = cwd ? lexicalPosix(String(cwd).replace(/\/+$/, "") || "/") : null;
  for (const raw of paths) {
    const absolute = raw.startsWith("/") ? lexicalPosix(raw) : base ? lexicalPosix(`${base}/${raw}`) : null;
    if (!absolute || !allowed.some((root) => inside(absolute, root))) return refuse();
    if (typeof isSymlink === "function") {
      let linked = false;
      try {
        linked = ancestors(absolute).some((prefix) => isSymlink(prefix) === true);
      } catch {
        linked = true;
      }
      if (linked) return refuse();
    }
  }
  return { allow: true, decision: "allow", path: pathText };
}

/** The scene outcome when a permission ask is still open at the end, or null when none is. Not a plain FAIL. */
export function stuckPermissionOutcome(asks) {
  if (!Array.isArray(asks) || !asks.length) return null;
  const ask = asks[0] ?? {};
  const paths = Array.isArray(ask.paths) ? ask.paths : [];
  const named = paths.find((p) => typeof p === "string" && p.trim()) || (typeof ask.command === "string" && ask.command.trim() ? ask.command : "(no path)");
  return `stuck on a permission ask: ${named}`;
}

