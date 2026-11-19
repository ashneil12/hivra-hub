// WP-110: one line in the chat header. A started worktree shows where it runs.
// Before the first send, ask tells the person the composer is already on a worktree.
import { useSyncExternalStore } from "react";
import { formatGitLabel } from "../../../app/shell/gitLabel";
import { pathKey, projectName } from "../../../shared/lib/paths";
import {
  loadNewChatWorktree,
  subscribeNewChatWorktree,
  type NewChatWorktree,
} from "../../settings/model/settings";
import type { Session } from "../model/session";
import { newChatWorktreeAskLine } from "../../source-control/model/newChatWorktree";
import { worktreeIncludeLines } from "../../source-control/model/worktreeIncludeNote";

const APP_CHECKOUT = /^mc-[0-9a-f]{6,}$/i;

/** The existing branch label when it names something, otherwise a plain worktree line. */
export function newChatWorktreeHeaderLabel(path: string, branch?: string): string {
  const repo = projectName(path);
  const existing = formatGitLabel(repo, branch);
  if (existing) return existing;
  if (repo && repo !== "~" && !APP_CHECKOUT.test(repo)) return `Worktree ${repo}`;
  return "Worktree";
}

const settingOff = (): NewChatWorktree => "off";

export function NewChatWorktreeBanner({ session }: { session: Session }) {
  const setting = useSyncExternalStore(
    subscribeNewChatWorktree,
    loadNewChatWorktree,
    settingOff,
  );
  if (
    session.worktreeCwd &&
    !session.worktreeRemoved &&
    pathKey(session.worktreeCwd) !== pathKey(session.cwd)
  ) {
    const include = worktreeIncludeLines(session);
    const line =
      "shrink-0 truncate border-b border-stroke px-3 py-1 text-xs text-content/70";
    return (
      <>
        <p data-worktree-header="" className={line}>
          {newChatWorktreeHeaderLabel(session.worktreeCwd, session.branch)}
        </p>
        {include.note ? (
          <p data-worktree-include="" className={line}>
            {include.note}
          </p>
        ) : null}
        {include.warning ? (
          <p data-worktree-include-warning="" className={line}>
            {include.warning}
          </p>
        ) : null}
      </>
    );
  }
  const line = newChatWorktreeAskLine(session, setting);
  if (!line) return null;
  return (
    <p
      data-new-chat-worktree-ask=""
      className="shrink-0 border-b border-stroke px-3 py-1 text-xs text-content/70"
    >
      {line}
    </p>
  );
}
