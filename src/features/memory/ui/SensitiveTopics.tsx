// Sensitive topics in Settings > Memory (model/sensitive.ts): the switch (on unless the person turns it off), and
// the bar over the kept list that shows only those facts or removes them all. Removing asks once more, in place.

import { saveSensitive, useSensitive } from "../model/sensitive";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";

export function SensitiveTopicsChoice({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Sensitive topics" data-sensitive-topics>
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-content/10 px-3 py-2 text-sm">
        <input type="checkbox" className="mt-1" checked={value} onChange={(event) => onChange(event.target.checked)} />
        <span className="flex flex-col gap-0.5">
          <span>Remember sensitive topics</span>
          <span className="text-content/60">Health, faith, politics, money and identity. Off means nothing new on these is kept unless you say "remember".</span>
        </span>
      </label>
    </section>
  );
}

/** The saved setting. */
export function SensitiveTopicsSetting() {
  const on = useSensitive();
  return <SensitiveTopicsChoice value={on} onChange={saveSensitive} />;
}

export function SensitiveBar({
  count,
  only,
  confirming,
  busy,
  onOnly,
  onConfirming,
  onRemove,
}: {
  count: number;
  only: boolean;
  confirming: boolean;
  busy: boolean;
  onOnly: (only: boolean) => void;
  onConfirming: (confirming: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-sensitive-bar>
      <p className="text-content/60">{count === 1 ? "1 kept fact is on a sensitive topic." : `${count} kept facts are on sensitive topics.`}</p>
      <button type="button" className={BTN} aria-pressed={only} onClick={() => onOnly(!only)}>
        {only ? "Show everything" : "Show only these"}
      </button>
      {confirming ? (
        <>
          <button type="button" className={BTN} disabled={busy} data-sensitive-remove-confirm onClick={onRemove}>
            {count === 1 ? "Yes, remove it for good" : `Yes, remove all ${count} for good`}
          </button>
          <button type="button" className={BTN} onClick={() => onConfirming(false)}>
            Keep them
          </button>
        </>
      ) : (
        <button type="button" className={BTN} disabled={busy} data-sensitive-remove onClick={() => onConfirming(true)}>
          {count === 1 ? "Remove it" : "Remove them all"}
        </button>
      )}
    </div>
  );
}
