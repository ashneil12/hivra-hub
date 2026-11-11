// A project's own repo, from its git origin. A pull-request watch is not a source of ownership:
// a watch is filed under whatever project the owner has open.

/** `owner/repo` from an origin URL. Anything else is not a repo. */
export function repoFromOriginUrl(url: string | null | undefined): string | undefined {
  const raw = (url ?? "").trim();
  if (!raw || /[\s\0]/.test(raw)) return undefined;
  let path = raw;
  const scp = /^[^/:@]+@[^/:@]+:(.+)$/.exec(raw);
  if (scp && !raw.includes("://")) path = scp[1];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return undefined;
    }
  }
  path = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;
  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!repo || !owner || owner === "." || owner === ".." || repo === "." || repo === "..") return undefined;
  if (owner.includes("..") || repo.includes("..")) return undefined;
  return `${owner}/${repo}`;
}

/** The origin url in a git config, when the origin remote has one. */
export function originUrlFromGitConfig(text: string): string | undefined {
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]?.trim() ?? "");
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.*?)\s*$/.exec(line);
    const value = url?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The git dir a worktree's `.git` file points at. A config file is not one. */
export function gitdirFromGitFile(text: string): string | undefined {
  const match = /^\s*gitdir:\s*(.+?)\s*$/im.exec(text);
  const dir = match?.[1]?.trim();
  if (!dir || dir.includes("\0")) return undefined;
  return dir;
}

/**
 * The main git dir a worktree or submodule `.git` file may follow.
 * Only `.git/worktrees/<name>` and `.git/modules/<name>`. Anything else is refused.
 */
export function commonGitDir(gitdir: string, commondirText: string): string | undefined {
  const rel = commondirText.replace(/\r/g, "").trim();
  if (!rel || rel.includes("\0") || rel.includes("\n")) return undefined;
  const git = joinRepoPath(gitdir, ".");
  const common = joinRepoPath(git, rel);
  const slash = git.includes("\\") && !git.includes("/") ? "\\" : "/";
  for (const kind of ["worktrees", "modules"]) {
    const prefix = `${common}${slash}${kind}${slash}`;
    if (!git.startsWith(prefix)) continue;
    const name = git.slice(prefix.length);
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
    return common;
  }
  return undefined;
}

/** Join a folder and a git path. An absolute target stays absolute. `..` is resolved. */
export function joinRepoPath(base: string, rel: string): string {
  const target = rel.trim();
  if (!target) return base;
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("/") || target.startsWith("\\\\")) return target;
  const slash = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const parts = [...base.split(/[\\/]/), ...target.split(/[\\/]/)];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const prefix = base.startsWith("\\\\") ? "\\\\" : base.startsWith("/") ? "/" : "";
  return prefix + out.join(slash);
}
