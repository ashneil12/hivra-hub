import { useState } from "react";
import { prettyCwd } from "../../../shared/lib/paths";
import { ConfirmDelete } from "../../../shared/ui/ConfirmDelete";

export type SessionDeleteChoice = {
  confirmed: boolean;
  deleteWorktree: boolean;
};

/** The shared delete confirm (r30d), with the unused worktree offered too when the session had one of its own. */
export function DeleteSessionDialog({
  title,
  unusedWorktree,
  worktreeTicked = false,
  onClose,
}: {
  title: string;
  unusedWorktree?: string;
  /** r69: a sub-chat's own worktree is offered ticked (sessionDeletePlan.ts). */
  worktreeTicked?: boolean;
  onClose: (choice: SessionDeleteChoice) => void;
}) {
  const [deleteWorktree, setDeleteWorktree] = useState(worktreeTicked);
  return (
    <ConfirmDelete
      name={title}
      onCancel={() => onClose({ confirmed: false, deleteWorktree: false })}
      onDelete={() => onClose({ confirmed: true, deleteWorktree: !!unusedWorktree && deleteWorktree })}
    >
      {unusedWorktree ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={deleteWorktree}
            onChange={(e) => setDeleteWorktree(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Also delete the unused worktree
            <span className="mt-1 block break-all text-[11px] text-content/45">
              {prettyCwd(unusedWorktree)}
            </span>
            <span className="mt-1 block text-[11px] text-content/45">
              The branch is kept. If files have uncommitted changes, the
              worktree stays.
            </span>
          </span>
        </label>
      ) : null}
    </ConfirmDelete>
  );
}
