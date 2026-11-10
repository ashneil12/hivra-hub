import { isLocalProject, loadPinnedProjects, loadProjectRailOrder, loadRecents } from "../../projects/model/recents";

/**
 * The folders this window lists as projects (the rail: recents, pins, order). Rust keeps an imported chat's or
 * automation's folder only inside one of these or a project in the app's own record; the webview holds the rail, Rust
 * holds the record, so each supplies its own.
 */
export function railFolders(): string[] {
  try {
    return [...new Set([...loadRecents().map((p) => p.path), ...loadProjectRailOrder(), ...loadPinnedProjects()])].filter(isLocalProject);
  } catch {
    return [];
  }
}
