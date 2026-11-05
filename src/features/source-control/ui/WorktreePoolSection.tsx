import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { WorktreePool, type PoolSlotView } from "./WorktreePool";

type PoolStatus = {
  slots: PoolSlotView[];
  enabled: boolean;
  interactive: boolean;
  maxTrees: number;
  notice?: string;
};

/**
 * WP-82: the pool for this project. A late reply for a project the person already
 * left is dropped. Saving writes the new settings on top of a fresh read.
 */
export function WorktreePoolSection({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<PoolStatus>();
  const [pruneLines, setPruneLines] = useState<string[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!cwd) return undefined;
    let current = true;
    setStatus(undefined);
    setPruneLines(undefined);
    setError(undefined);
    invoke<PoolStatus>("worktree_pool_status", { cwd }).then(
      (next) => {
        if (current) setStatus(next);
      },
      (reason) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [cwd]);

  const save = (patch: Partial<Pick<PoolStatus, "enabled" | "interactive" | "maxTrees">>) => {
    if (!status) return;
    const next = { ...status, ...patch };
    setStatus(next);
    void invoke<Pick<PoolStatus, "enabled" | "interactive" | "maxTrees">>(
      "worktree_pool_set_settings",
      {
        cwd,
        enabled: next.enabled,
        interactive: next.interactive,
        maxTrees: next.maxTrees,
      },
    ).catch((reason) => setError(String(reason)));
  };

  if (!cwd) return null;
  if (error) {
    // Not an alert: the worktree page already uses that for a delete that was refused.
    return <p className="text-[12px] text-red-400">{error}</p>;
  }
  if (!status) return null;
  return (
    <WorktreePool
      enabled={status.enabled}
      interactive={status.interactive}
      maxTrees={status.maxTrees}
      slots={status.slots}
      notice={status.notice}
      pruneLines={pruneLines}
      onEnabled={(enabled) => save({ enabled })}
      onInteractive={(interactive) => save({ interactive })}
      onMaxTrees={(maxTrees) => save({ maxTrees })}
      onPrunePreview={() => {
        void invoke<{ lines: string[] }>("worktree_pool_prune", { cwd, yes: false }).then(
          (result) => setPruneLines(result.lines),
          (reason) => setError(String(reason)),
        );
      }}
      onPruneConfirm={() => {
        void invoke<{ lines: string[] }>("worktree_pool_prune", { cwd, yes: true }).then(
          (result) => {
            setPruneLines(result.lines);
            return invoke<PoolStatus>("worktree_pool_status", { cwd });
          },
          (reason) => {
            setError(String(reason));
            return undefined;
          },
        ).then((next) => {
          if (next) setStatus(next);
        });
      }}
      onPruneCancel={() => setPruneLines(undefined)}
    />
  );
}
