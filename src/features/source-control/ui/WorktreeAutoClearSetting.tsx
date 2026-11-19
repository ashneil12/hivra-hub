import { useEffect, useState } from "react";
import { appPolicy } from "../../../app/model/appIdentity";
import {
  AUTO_CLEAR_DEFAULT,
  describeAutoClearRun,
  loadAutoClear,
  saveAutoClear,
  type AutoClearStatus,
} from "../model/worktreeAutoClear";

/**
 * Settings > Worktrees: whether a finished worktree gives its build output back by itself. On until it is turned off.
 * The sweep runs in the app (src-tauri/src/worktree_autoclean.rs); this is only the switch and what the last check did.
 */
export function WorktreeAutoClearSetting() {
  const [status, setStatus] = useState<AutoClearStatus>();
  const [enabled, setEnabled] = useState(AUTO_CLEAR_DEFAULT);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const sweeps = appPolicy().clearBuildOutput;

  useEffect(() => {
    let current = true;
    loadAutoClear().then(
      (next) => {
        // An answer that isn't a status leaves the default showing.
        if (!current || typeof next?.enabled !== "boolean") return;
        setStatus(next);
        setEnabled(next.enabled);
      },
      (reason) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const change = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveAutoClear(next);
      if (typeof saved?.enabled === "boolean") {
        setStatus(saved);
        setEnabled(saved.enabled);
      }
    } catch (reason) {
      setEnabled(!next);
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const lastRun = status?.lastRun;
  return (
    <div
      id="setting-worktree-autoclear"
      data-setting-id="worktree-autoclear"
      className="flex flex-col gap-1.5"
    >
      <label className="flex cursor-pointer items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled}
          disabled={saving || (!status && !error)}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>Clear build output of finished worktrees</span>
      </label>
      <p className="pl-6 text-[12px] text-content/50">
        When a worktree&apos;s pull request is merged or closed, or its task is accepted and its
        branch is pushed, and git shows no changes in it, its target/, src-tauri/target/,
        test-results/, playwright-report/ and node_modules/ folders are deleted. A node_modules
        that is a link is kept. Code, branches and chats stay. A worktree with something running
        in it, or touched in the last ten minutes, waits.
      </p>
      {!sweeps && (
        <p className="pl-6 text-[12px] text-content/50">
          This is a dev copy, so it never clears anything. The daily app does.
        </p>
      )}
      {status?.running && (
        <p className="pl-6 text-[12px] text-content/50">Checking worktrees now.</p>
      )}
      {lastRun && (
        <p className="pl-6 text-[12px] text-content/65">
          {describeAutoClearRun(lastRun, Date.now())}
        </p>
      )}
      {error && (
        // Not an alert: the worktree page already uses that for a delete that was refused.
        <p className="break-words pl-6 text-[12px] text-red-400">{error}</p>
      )}
    </div>
  );
}
