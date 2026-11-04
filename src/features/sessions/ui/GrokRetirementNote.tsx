import { useState } from "react";
import { GlassBackdrop } from "../../../app/shell/GlassBackdrop";
import {
  dismissGrokRetirementNote,
  pendingGrokRetirementNote,
} from "../model/grokRetirement";

/**
 * WP-16: the one-time note after a retired launcher path is cleared. It shows
 * once in this process; a later start finds the flag and stays quiet.
 */
export function GrokRetirementNote() {
  const [note, setNote] = useState<string | null>(() => pendingGrokRetirementNote());
  if (!note) return null;
  return (
    <div
      role="status"
      data-grok-retirement-note
      className="fixed bottom-4 left-1/2 z-[2147483000] flex w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 items-start gap-3 overflow-hidden rounded-lg px-3 py-2 font-sans text-[13px] text-content shadow-lg isolate"
    >
      <GlassBackdrop />
      <p className="relative z-[1] min-w-0 flex-1">{note}</p>
      <button
        type="button"
        className="relative z-[1] shrink-0 rounded-md px-2 py-1 text-content/70 hover:bg-content/10"
        onClick={() => {
          dismissGrokRetirementNote();
          setNote(null);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
