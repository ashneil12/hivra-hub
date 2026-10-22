// One confirm for every delete Ash can do from the sidebar and the rail (r30d; Critiquito, 22 Oct): a session, a chat (a
// Mono's 1:1, a team's sub-chat) and a room. It names what goes ("Delete Example: tidy the README?"), says it can't be
// undone, and offers Cancel and a red Delete. Cancel has the focus, so Enter (or Escape, or a click outside) cancels:
// nothing is deleted by a stray key. Callers that need more (an unused worktree to clear too) put it in `children`.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Modal } from "./Modal";

/**
 * Cancel's focus ring (r30e, Critiquito): shown whenever it has focus, from the moment the dialog opens and after a
 * mouse click too (`focus:`, not `focus-visible:`), so Ash can see Enter is the safe key. The app's accent ring, set off
 * by a solid ring of the dialog's own surface so it never sits on bare glass. In the light theme the accent alone is
 * under 3:1 (2.69:1), so `confirm-cancel-ring` (index.css) mixes it toward the text colour there (r30f).
 */
export const CANCEL_FOCUS_RING =
  "confirm-cancel-ring focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background-base";

export function ConfirmDelete({
  name,
  detail,
  children,
  deleteLabel = "Delete",
  onCancel,
  onDelete,
}: {
  /** What is deleted, as Ash knows it: a session's or chat's title, a room's name. */
  name: string;
  /** Said before "This can't be undone.", e.g. what else goes with a Mono. */
  detail?: string;
  children?: ReactNode;
  deleteLabel?: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <Modal title={`Delete ${name}?`} size="sm" hideClose onClose={onCancel} scrimClassName="confirm-scrim">
      <div className="flex flex-col gap-4 px-4 pb-4 pt-2 text-[12px]" data-confirm-delete={name}>
        <p className="text-content/80">{detail ? `${detail} ` : ""}This can't be undone.</p>
        {children}
        <div className="flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            data-confirm-delete-cancel
            onClick={onCancel}
            className={`rounded-md px-3 py-1.5 text-content/85 hover:bg-content/8 active:scale-[0.97] ${CANCEL_FOCUS_RING}`}
          >
            Cancel
          </button>
          <button
            type="button"
            data-confirm-delete-ok
            onClick={onDelete}
            className="rounded-md bg-red-500/20 px-3 py-1.5 font-medium text-red-400 ring-red-400/50 hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 active:scale-[0.97]"
          >
            {deleteLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- asked from anywhere: `await confirmDelete("Example: tidy the README")` -------------------------------------------

type Ask = { name: string; detail?: string; resolve: (ok: boolean) => void };
let current: Ask | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Ask Ash to confirm deleting `name`; true only when he picked Delete. One question at a time: a second waits as no. */
export function confirmDelete(name: string, detail?: string): Promise<boolean> {
  if (current) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { name: name.trim() || "this", detail, resolve };
    emit();
  });
}

function answer(ok: boolean): void {
  const ask = current;
  current = undefined;
  emit();
  ask?.resolve(ok);
}

/** Tests: drop a question left open. */
export function resetConfirmDelete(): void {
  if (current) answer(false);
}

/** Where `confirmDelete` shows: mounted once in the app's window. */
export function ConfirmDeleteHost() {
  const ask = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
  if (!ask) return null;
  return <ConfirmDelete key={ask.name} name={ask.name} detail={ask.detail} onCancel={() => answer(false)} onDelete={() => answer(true)} />;
}
