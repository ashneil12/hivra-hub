// WP-121: the line that says a mid-thread switch continues this chat, or starts a recap.
// Absent when nothing changed, so a switch is never silent.

export function MidThreadSwitchNotice({
  line,
  place,
}: {
  line?: string;
  place: "header" | "composer";
}) {
  const text = line?.trim();
  if (!text) return null;
  return (
    <p
      data-mid-thread-switch={place}
      className={
        place === "header"
          ? "shrink-0 truncate border-b border-stroke px-3 py-1 text-xs text-content/70"
          : "px-3 pt-2 text-xs text-content/70"
      }
    >
      {text}
    </p>
  );
}
