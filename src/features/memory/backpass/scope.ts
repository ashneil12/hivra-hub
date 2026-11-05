// WP-83: what a run is allowed to edit. A path from disk or from a model is untrusted.

export type FileRole = "instruction" | "soul" | "skill" | "user" | "opinions" | "voice";

export type ScopeFile = { path: string; role: FileRole; picked?: boolean };

export type Scope = { files: ScopeFile[]; pluginRoots: string[] };

export function segments(file: string): string[] {
  return file.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
}

/** Installed plugins, including pstack. A project's own named file is not this. */
export function isPluginPath(file: string, roots: string[]): boolean {
  const norm = file.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const root of roots) {
    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!base) continue;
    if (norm === base || norm.startsWith(`${base}/`)) return true;
  }
  const parts = segments(file).map((part) => part.toLowerCase());
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === "plugins" && (parts[i + 1] === "installed" || parts[i + 1] === "pstack")) return true;
    if (parts[i] === "pstack" && parts[i + 1] === "skills") return true;
  }
  return false;
}

export function hasDotDot(file: string): boolean {
  return segments(file).some((part) => part === "..") || file.split(/[/\\]/).includes("..");
}

/**
 * Refuse a file the run did not name, a plugin file even if someone named it,
 * a user file that was not picked, and any path that climbs out with `..`.
 */
export function scopeRefusal(file: string, role: FileRole, scope: Scope): string | null {
  if (hasDotDot(file) || file.includes("\0")) return "That path is not inside the named file.";
  if (isPluginPath(file, scope.pluginRoots)) {
    return "A plugin's files are not edited. A lesson about a plugin goes in the first mate's own instructions.";
  }
  const named = scope.files.find((entry) => samePath(entry.path, file));
  if (!named) return "This run did not name that file.";
  if (named.role !== role) return "This run did not name that file for this edit.";
  if (role === "user" && named.picked !== true) return "The user file is only edited when you pick it.";
  return null;
}

export function samePath(left: string, right: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(left) === norm(right);
}
