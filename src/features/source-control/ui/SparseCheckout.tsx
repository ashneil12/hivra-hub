export type SparseCheckoutProps = {
  enabled: boolean;
  note?: string;
  onChange: (enabled: boolean) => void;
};

const LABEL = "Use a sparse checkout for new worktrees on this project";

/** Settings, Worktrees: the sparse checkout switch. Off until this project turns it on. */
export function SparseCheckout({ enabled, note, onChange }: SparseCheckoutProps) {
  return (
    <section
      id="setting-sparse-checkout"
      data-setting-id="sparse-checkout"
      aria-label="Sparse checkout"
      className="flex flex-col gap-2 rounded-xl border border-stroke p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">Sparse checkout</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={LABEL}
          onClick={() => onChange(!enabled)}
          className="flex items-center gap-2 text-left text-[12px] text-content/80"
        >
          <span
            className={`relative h-4 w-7 shrink-0 rounded-full ${enabled ? "bg-content/70" : "bg-content/20"}`}
          >
            <span
              className={`absolute top-0.5 size-3 rounded-full bg-white ${enabled ? "left-3.5" : "left-0.5"}`}
            />
          </span>
          {LABEL}
        </button>
      </div>
      <p className="text-[12px] text-content/55">
        Off keeps ordinary git worktrees. This does not change the main checkout.
      </p>
      {note && <p className="text-[12px] text-content/70">{note}</p>}
    </section>
  );
}

export const SPARSE_SLOT_NOTE =
  "This checkout is sparse. Git does not see it as a worktree, so actions on it stay on the pinned tool.";

/** Shown on a checkout git does not list. Later actions stay on the pinned tool. */
export function SparseSlotNote({ text }: { text: string }) {
  return <p className="mt-2 text-[11px] text-content/55">{text}</p>;
}
