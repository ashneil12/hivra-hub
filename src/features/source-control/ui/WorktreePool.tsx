export type PoolSlotView = {
  path: string;
  holder?: string;
  state: string;
  bytes?: number;
  reason?: string;
  branch?: string;
};

export type WorktreePoolProps = {
  enabled: boolean;
  interactive: boolean;
  maxTrees: number;
  slots: PoolSlotView[];
  notice?: string;
  pruneLines?: string[];
  onEnabled: (enabled: boolean) => void;
  onInteractive: (interactive: boolean) => void;
  onMaxTrees: (maxTrees: number) => void;
  onPrunePreview: () => void;
  onPruneConfirm: () => void;
  onPruneCancel: () => void;
};

function formatSize(bytes?: number): string {
  if (bytes == null) return "Size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function stateLabel(state: string): string {
  if (state === "leased" || state === "available" || state === "dirty" || state === "quarantined") {
    return state;
  }
  return "quarantined";
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[12px] text-content/80"
    >
      <span
        className={`relative h-4 w-7 rounded-full ${checked ? "bg-content/70" : "bg-content/20"}`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-white ${checked ? "left-3.5" : "left-0.5"}`}
        />
      </span>
      {label}
    </button>
  );
}

/** Settings → Worktrees: the ready-worktree pool. Nothing is removed until the confirm tap. */
export function WorktreePool({
  enabled,
  interactive,
  maxTrees,
  slots,
  notice,
  pruneLines,
  onEnabled,
  onInteractive,
  onMaxTrees,
  onPrunePreview,
  onPruneConfirm,
  onPruneCancel,
}: WorktreePoolProps) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-stroke p-4" aria-label="Worktree pool">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">Worktree pool</h3>
        <Switch label="Use the worktree pool" checked={enabled} onChange={onEnabled} />
      </div>
      {notice && <p className="text-[12px] text-content/70">{notice}</p>}
      <div className="flex flex-wrap items-center gap-4">
        <Switch
          label="New worktree uses the pool"
          checked={interactive}
          onChange={onInteractive}
        />
        <label className="flex items-center gap-2 text-[12px] text-content/70">
          Worktrees per project
          <input
            type="number"
            min={1}
            max={32}
            value={maxTrees}
            aria-label="Worktrees per project"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next)) onMaxTrees(next);
            }}
            className="h-7 w-16 rounded-md bg-content/8 px-2 text-[12px]"
          />
        </label>
      </div>
      {slots.length === 0 ? (
        <p className="text-[12px] text-content/50">No pooled worktrees yet.</p>
      ) : (
        <ul className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke">
          {slots.map((slot) => {
            const state = stateLabel(slot.state);
            return (
              <li key={slot.path} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="break-all text-[12px] font-medium">{slot.path}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-content/55">
                    <span>{state}</span>
                    {slot.holder && <span>Leased to {slot.holder}</span>}
                    {slot.branch && <span>{slot.branch}</span>}
                    <span>{formatSize(slot.bytes)}</span>
                  </p>
                  {slot.reason && (
                    <p className="mt-1 text-[11px] text-amber-400">{slot.reason}</p>
                  )}
                </div>
                {state !== "leased" ? null : (
                  <span className="text-[11px] text-content/40">In use</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pruneLines ? (
        <div className="flex flex-col gap-2 rounded-lg bg-content/8 p-3">
          <p className="text-[12px]">Idle worktrees that would be removed</p>
          <ul className="text-[11px] text-content/70">
            {pruneLines.length === 0 ? (
              <li>Nothing to remove.</li>
            ) : (
              pruneLines.map((line) => (
                <li key={line} className="break-all">
                  {line}
                </li>
              ))
            )}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPruneConfirm}
              className="rounded-md bg-content/12 px-2 py-1 text-[11px] hover:bg-content/20"
            >
              Remove these idle worktrees
            </button>
            <button
              type="button"
              onClick={onPruneCancel}
              className="rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/8"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPrunePreview}
          className="w-fit rounded-md bg-content/8 px-2 py-1 text-[11px] hover:bg-content/12"
        >
          Prune idle worktrees
        </button>
      )}
    </section>
  );
}
