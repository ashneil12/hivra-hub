// WP-111: the small label on a private chat.

export function PrivateMark({ on }: { on?: boolean }) {
  if (on !== true) return null;
  return (
    <span
      data-private-chat=""
      className="shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[10px] font-medium text-content/70"
    >
      Private
    </span>
  );
}
