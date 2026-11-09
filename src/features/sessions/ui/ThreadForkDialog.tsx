import { useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../../../shared/lib/layers";
import { NativePopupHost } from "../../../shared/ui/NativePopupHost";

type Props = {
  error: string | null;
  busy?: boolean;
  worktree?: {
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  onFork: () => void;
  onCancel: () => void;
};

/** Confirm before a chat is copied from one message. */
export function ThreadForkDialog({
  error,
  busy = false,
  worktree,
  onFork,
  onCancel,
}: Props) {
  const host = useContext(NativePopupHost);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return createPortal(
    <div
      className={host ? "relative" : "fixed inset-0"}
      style={{ zIndex: LAYER.dialog }}
    >
      <div
        className="dialog-scrim absolute inset-0 z-0 bg-black/30"
        onMouseDown={() => {
          onCancel();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-fork-title"
        data-thread-fork-dialog
        onMouseDown={(event) => event.stopPropagation()}
        className={`modal-surface ${host ? "relative w-full" : "absolute left-1/2 top-[22%] w-[min(420px,calc(100vw-24px))] -translate-x-1/2"} z-[1] flex flex-col gap-3 rounded-lg border border-content/10 dialog-glass p-4 shadow-xl`}
      >
        <div className="flex flex-col gap-1">
          <h2
            id="thread-fork-title"
            className="text-[13px] font-medium leading-tight text-content"
          >
            Fork this chat?
          </h2>
          <p className="text-[12px] leading-snug text-content/55">
            A new chat keeps the messages up to here. This chat stays as it is.
          </p>
        </div>
        {worktree ? (
          <label className="flex items-center gap-2 text-[12px] text-content/80">
            <input
              type="checkbox"
              data-thread-fork-worktree
              checked={worktree.checked}
              disabled={busy}
              onChange={(event) => worktree.onChange(event.currentTarget.checked)}
            />
            Start the new chat in its own worktree.
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-[11px] leading-4 text-red-400/90">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-thread-fork-cancel
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-thread-fork-confirm
            disabled={busy}
            onClick={onFork}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
          >
            Fork
          </button>
        </div>
      </div>
    </div>,
    host ?? document.body,
  );
}
