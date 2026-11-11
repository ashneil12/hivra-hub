// WP-138: what a new worktree's .worktreeinclude copy did, where the worktree was made
// outside a chat (the sidebar switcher, Settings > Worktrees). A chat shows the same two
// lines in its header (NewChatWorktreeBanner). `lines` are already safe to show
// (worktreeIncludeLinesOf).
import type { WorktreeIncludeLines as Lines } from "../model/worktreeIncludeNote";

export function hasIncludeLines(lines: Lines): boolean {
  return !!(lines.note || lines.warning);
}

export function WorktreeIncludeLines({
  lines,
  className = "",
}: {
  lines: Lines;
  className?: string;
}) {
  return (
    <>
      {lines.warning ? (
        <p
          role="alert"
          data-worktree-include-warning=""
          className={`break-words text-amber-400 ${className}`}
        >
          {lines.warning}
        </p>
      ) : null}
      {lines.note ? (
        <p
          data-worktree-include=""
          className={`break-words text-content/60 ${className}`}
        >
          {lines.note}
        </p>
      ) : null}
    </>
  );
}
