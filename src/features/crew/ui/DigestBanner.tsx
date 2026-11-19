// Hivra WP-15: needs you now, and at most one digest for everything else.

type Line = { id: string; title: string };

export function DigestBanner({
  immediate,
  digest,
  onOpen,
}: {
  immediate: readonly Line[];
  digest: readonly Line[] | null;
  /** Opens what a line is about (its card below, or the chat of the work that needs you). Without it a line is plain text. */
  onOpen?: (id: string) => void;
}) {
  const now = immediate.filter((item) => item.title.trim());
  const digestIds = new Set(now.map((item) => item.id));
  const hour = (digest ?? []).filter((item) => item.title.trim() && !digestIds.has(item.id));
  if (now.length === 0 && hour.length === 0) return null;
  const lines = (items: readonly Line[], urgent: boolean) => (
    <ul className="-mx-1 flex flex-col gap-px">
      {items.map((item) => (
        <li key={item.id}>
          {onOpen ? (
            <button
              type="button"
              data-digest-open={item.id}
              onClick={() => onOpen(item.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] text-content hover:bg-content/5"
            >
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${urgent ? "bg-red-400" : "bg-content/30"}`} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
            </button>
          ) : (
            <span className="block px-1 text-[13px] text-content">{item.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {now.length ? (
        <section data-immediate aria-label="Needs you now">
          <h3 className="pb-0.5 text-[12px] text-content/50">Needs you now</h3>
          {lines(now, true)}
        </section>
      ) : null}
      {hour.length ? (
        <section data-digest aria-label="In the last hour">
          <h3 className="pb-0.5 text-[12px] text-content/50">In the last hour</h3>
          {lines(hour, false)}
        </section>
      ) : null}
    </div>
  );
}
