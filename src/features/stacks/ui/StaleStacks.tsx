import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { StaleStackList, type StaleStackView } from "./StackList";

/**
 * WP-87: stacks whose worktree is gone. Shown in Clean up. Nothing is removed until a tap.
 * A failed refresh keeps the rows already shown.
 */
export function StaleStacks() {
  const [rows, setRows] = useState<StaleStackView[]>([]);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    invoke<StaleStackView[]>("stack_stale").then(
      (next) => {
        if (current && Array.isArray(next)) {
          setRows(next);
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
  }, [tick]);

  const remove = (id: string) => {
    invoke("stack_remove_stale", { id }).then(
      () => setTick((value) => value + 1),
      (reason) => setError(String(reason)),
    );
  };

  if (rows.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-[12px] text-content/70">{error}</p> : null}
      <StaleStackList stacks={rows} onRemove={remove} />
    </div>
  );
}
