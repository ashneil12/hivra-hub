// WP-124: the stash and restore buttons, and whether this chat has a saved draft.

import { useEffect, useState } from "react";
import { peekStash, STASH_EVENT, STASH_STORAGE_KEY } from "../model/draftStash";

/** True when this chat has a stashed draft. The same window and another window both refresh it. */
export function useStashPresent(sessionId: string | undefined): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    const read = () => setPresent(sessionId ? peekStash(sessionId) !== null : false);
    read();
    const onStorage = (event: StorageEvent) => {
      if (event.key != null && event.key !== STASH_STORAGE_KEY) return;
      read();
    };
    window.addEventListener(STASH_EVENT, read);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STASH_EVENT, read);
      window.removeEventListener("storage", onStorage);
    };
  }, [sessionId]);
  return present;
}

export function DraftStashActions({
  canStash,
  canRestore,
  onStash,
  onRestore,
}: {
  canStash: boolean;
  canRestore: boolean;
  onStash: () => void;
  onRestore: () => void;
}) {
  if (!canStash && !canRestore) return null;
  return (
    <p className="flex items-center gap-2 px-3 pt-2 text-xs text-content/55">
      {canStash ? (
        <button
          type="button"
          aria-label="Stash draft"
          className="rounded px-1 py-0.5 text-content/70 hover:bg-content/8"
          onClick={onStash}
        >
          Stash draft
        </button>
      ) : null}
      {canRestore ? (
        <button
          type="button"
          aria-label="Restore draft"
          className="rounded px-1 py-0.5 text-content/70 hover:bg-content/8"
          onClick={onRestore}
        >
          Restore draft
        </button>
      ) : null}
    </p>
  );
}
