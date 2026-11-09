// WP-124: confirm before an earlier-prompt edit drops the replies that came after it.

export function EarlierPromptConfirm({
  open,
  onKeep,
  onRemove,
}: {
  open: boolean;
  onKeep: () => void;
  onRemove: () => void;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="earlier-prompt-title"
      data-earlier-prompt-confirm
      className="fixed inset-0 z-50 grid place-items-center bg-content/20 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-content/15 bg-surface p-4 shadow-xl">
        <p id="earlier-prompt-title" className="font-sans text-sm text-content">
          Later replies belong to the earlier prompt. Remove them and send this instead?
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 font-sans text-sm text-content/70 hover:bg-content/8"
            onClick={onKeep}
          >
            Keep later replies
          </button>
          <button
            type="button"
            className="rounded-md bg-content/10 px-2 py-1 font-sans text-sm text-content hover:bg-content/15"
            onClick={onRemove}
          >
            Remove and send
          </button>
        </div>
      </div>
    </div>
  );
}
