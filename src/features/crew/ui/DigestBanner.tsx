// Hivra WP-15: needs you now, and at most one digest for everything else.

export function DigestBanner({
  immediate,
  digest,
}: {
  immediate: readonly { id: string; title: string }[];
  digest: readonly { id: string; title: string }[] | null;
}) {
  const now = immediate.filter((item) => item.title.trim());
  const digestIds = new Set(now.map((item) => item.id));
  const hour = (digest ?? []).filter((item) => item.title.trim() && !digestIds.has(item.id));
  if (now.length === 0 && hour.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {now.length ? (
        <section data-immediate aria-label="Needs you now">
          <h3 className="text-[12px] text-content/50">Needs you now</h3>
          <ul>
            {now.map((item) => (
              <li key={item.id} className="text-[13px] text-content">
                {item.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {hour.length ? (
        <section data-digest aria-label="In the last hour">
          <h3 className="text-[12px] text-content/50">In the last hour</h3>
          <ul>
            {hour.map((item) => (
              <li key={item.id} className="text-[13px] text-content">
                {item.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
