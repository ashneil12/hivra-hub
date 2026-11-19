// The "Chat tidied" line: where a first mate's chat moved to a fresh engine session because the old one was full
// (monos/model/monoRotation.ts). The chat itself lost nothing. Opened, it shows what the fresh session was handed,
// read-only. It sits above the message of Ash's that opened the fresh session (monos/model/chatSegments.ts).
import { useState, useSyncExternalStore } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import { segmentOpenedBy, segmentStore } from "../model/chatSegments";

function subscribe(fn: () => void): () => void {
  return segmentStore().subscribe(fn);
}

function snapshot() {
  return segmentStore().doc();
}

const stamp = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ChatTidied({ blockId }: { blockId: string }) {
  const doc = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [open, setOpen] = useState(false);
  const segment = segmentOpenedBy(doc, blockId);
  if (!segment) return null;
  return (
    <div data-chat-tidied={blockId} className="-ml-10 mb-3 w-[calc(100%+2.5rem)] font-sans" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-stroke" />
        <button
          type="button"
          aria-expanded={open}
          title="The chat was getting long, so your first mate carried on with a fresh memory of it. Nothing was lost."
          onClick={() => setOpen((value) => !value)}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
        >
          <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
          <span>{`Chat tidied, ${stamp.format(segment.at)}`}</span>
        </button>
        <span aria-hidden className="h-px flex-1 bg-stroke" />
      </div>
      {open ? (
        <div className="mt-1 rounded-lg border border-stroke p-3 text-left">
          <p className="mb-2 text-xs text-content/60">Nothing was lost. This is what your first mate carried over.</p>
          <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-content/80">{segment.given || "Nothing was written down for this one."}</pre>
        </div>
      ) : null}
    </div>
  );
}
