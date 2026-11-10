// WP-165: the only files the scout reads are inside the project, or inside the folder the person picked.

import { isEqualOrInside, joinPath } from "../../../shared/lib/paths";

export const SOURCES_FILE = "docs/hivra/SOURCES.md";
export const WATCH_FILE_NAME = "watch.md";

/** A file inside `root`, or null when the relative path would leave it. */
export function fileInside(root: string, relative: string): string | null {
  if (typeof root !== "string" || typeof relative !== "string") return null;
  const base = root.trim();
  const child = relative.trim();
  if (!base || !child) return null;
  if (!absolutePath(base)) return null;
  if (base.includes("\0") || child.includes("\0")) return null;
  if (base.split(/[/\\]/).concat(child.split(/[/\\]/)).some((part) => part === "..")) return null;
  const full = joinPath(base, child);
  if (!isEqualOrInside(full, base)) return null;
  return full;
}

function absolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || path.startsWith("//") || /^[A-Za-z]:[\\/]/.test(path);
}

/** A project id from the folder name. The full path is not kept. */
export function projectKeyFromCwd(cwd: string): string {
  if (typeof cwd !== "string") return "project";
  const base = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "project";
}
