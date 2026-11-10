// WP-135: loser worktrees leave through the existing clean-up, not a private delete.
import { pathKey } from "../../../shared/lib/paths";
import { listWorktrees, type RemoveWorktree } from "../../source-control/model/worktrees";
import {
  janitorClean,
  janitorReport,
  removeCheckedWorktree,
} from "../../source-control/model/worktreeJanitor";
import type { FanOutCleanupPort } from "./fanOutDecide";

/**
 * Roots and verdicts for one project, and the stop a discard needs. A throw means the janitor has not answered
 * (or, for `stop`, that the chat may still be running).
 */
export function fanOutJanitorPort(
  cwd: string,
  onRemove: RemoveWorktree,
  stop: (childId: string) => Promise<void>,
): FanOutCleanupPort {
  return {
    stop,
    allowedRoots: async () => {
      const listed = await listWorktrees(cwd);
      const root = typeof listed.defaultRoot === "string" ? listed.defaultRoot.trim() : "";
      return root ? [root] : [];
    },
    inspect: async (path) => {
      const report = await janitorReport(cwd);
      const entry = report.entries.find((item) => pathKey(item.path) === pathKey(path));
      if (!entry) throw new Error("missing");
      return entry.verdict.outcome === "remove" ? "remove" : "keep";
    },
    remove: async (path) => {
      const report = await janitorReport(cwd);
      const entry = report.entries.find((item) => pathKey(item.path) === pathKey(path));
      if (!entry || entry.verdict.outcome !== "remove") throw new Error("not removable");
      const [cleaned] = await janitorClean("remove", [entry]);
      if (!cleaned?.done) throw new Error(cleaned?.message || "not ready");
      await removeCheckedWorktree({ path: cleaned.path, repo: cleaned.repo }, entry.head, onRemove);
    },
  };
}
