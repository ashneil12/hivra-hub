import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { StackList, type StackView } from "./StackList";

type StackStatus = {
  declared: boolean;
  url: string | null;
  stacks: StackView[];
};

/**
 * WP-87: this project's stacks. A late reply for a project the person already
 * left is dropped. A failed refresh keeps the rows already shown.
 */
export function WorktreeStacks({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<StackStatus>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return undefined;
    const requested = cwd;
    let current = true;
    invoke<StackStatus>("stack_status", { cwd: requested }).then(
      (next) => {
        if (current && next && Array.isArray(next.stacks)) {
          setStatus(next);
          setError(undefined);
        }
      },
      (reason) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [cwd, tick]);

  if (!status || (!status.declared && status.stacks.length === 0)) {
    return error ? <p className="text-[12px] text-content/70">{error}</p> : null;
  }

  const stop = (worktree: string) => {
    const requested = cwd;
    invoke("stack_down", { cwd: worktree }).then(
      () => {
        if (cwdRef.current === requested) setTick((value) => value + 1);
      },
      (reason) => {
        if (cwdRef.current === requested) setError(String(reason));
      },
    );
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-stroke p-4" aria-label="Worktree stacks">
      <h3 className="text-[13px] font-medium">Worktree stacks</h3>
      {error ? <p className="text-[12px] text-content/70">{error}</p> : null}
      <StackList
        stacks={status.stacks}
        onStop={stop}
        onReset={(worktree) => {
          const requested = cwd;
          invoke("stack_reset", { cwd: worktree }).then(
            () => {
              if (cwdRef.current === requested) setTick((value) => value + 1);
            },
            (reason) => {
              if (cwdRef.current === requested) setError(String(reason));
            },
          );
        }}
      />
    </section>
  );
}
