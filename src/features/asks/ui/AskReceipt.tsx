// The receipt under a message of Ash's: "Heard 7 asks", built from the ask ledger (model/asks.ts), not written by the
// first mate, so it reads the same on every engine. One quiet line; opened, it lists each ask in a plain line with
// where it stands. Ash can tick one off, drop one, bring one back, settle a "maybe", or add one that was missed.
// Nothing shows for a message the ledger holds no asks for.
import { Check, ChevronRight, Plus, RotateCcw, X } from "../../../shared/ui/icons";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { asksForBlock, isQuiet, receiptLine, STATUS_WORD, type Ask } from "../model/asks";
import { askStore } from "../model/askStore";

function subscribe(fn: () => void): () => void {
  return askStore().subscribe(fn);
}

function snapshot() {
  return askStore().doc();
}

/** A 14px ring, the app's one status glyph (hub/ui/StatusMark.tsx): filled when done, dashed for a maybe. */
function Mark({ ask }: { ask: Ask }) {
  const done = ask.status === "done";
  const waiting = ask.status === "waiting";
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden
      className={`mt-[3px] shrink-0 ${done ? "text-content/60" : "text-content/40"}`}
      style={waiting ? { color: NEEDS_YOU_RED } : undefined}
    >
      <circle
        cx="7"
        cy="7"
        r="6"
        fill={done ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={ask.status === "maybe" ? "2 2.5" : ask.status === "dropped" ? "1 3" : undefined}
      />
      {ask.status === "started" ? <circle cx="7" cy="7" r="2.5" fill="currentColor" /> : null}
    </svg>
  );
}

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-content/60 hover:bg-content/10 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
    >
      {children}
    </button>
  );
}

function Row({ ask }: { ask: Ask }) {
  const store = askStore();
  const set = (status: Ask["status"], note?: string) => void store.change(ask.id, { status, ...(note ? { note } : {}) }, "ash").catch(() => undefined);
  const closed = ask.status === "done" || ask.status === "dropped";
  const word = ask.kind === "idea" && ask.status === "heard" ? "Idea, for later" : STATUS_WORD[ask.status];
  return (
    <li
      data-ask={ask.n}
      data-ask-status={ask.status}
      className="group/ask flex min-w-0 items-start gap-2 rounded-md px-2 py-1 hover:bg-content/5"
    >
      <Mark ask={ask} />
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-snug ${closed ? "text-content/60" : "text-content"} ${ask.status === "dropped" ? "line-through" : ""}`} title={ask.quote}>
          {ask.summary}
        </p>
        <p className="text-xs text-content/60">
          <span style={ask.status === "waiting" ? { color: NEEDS_YOU_RED } : undefined}>{word}</span>
          {ask.note ? <span>{`: ${ask.note}`}</span> : null}
          {ask.status === "done" && ask.proof ? <span>{`: ${ask.proof}`}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/ask:opacity-100 group-hover/ask:opacity-100">
        {ask.status === "maybe" ? (
          <>
            <RowButton label="Yes, this is an ask" onClick={() => set("heard")}>
              <Check className="size-3.5" strokeWidth={1.75} />
            </RowButton>
            <RowButton label="Not an ask" onClick={() => set("dropped")}>
              <X className="size-3.5" strokeWidth={1.75} />
            </RowButton>
          </>
        ) : closed ? (
          <RowButton label="Reopen" onClick={() => set("heard")}>
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
          </RowButton>
        ) : (
          <>
            <RowButton label="Mark done" onClick={() => set("done")}>
              <Check className="size-3.5" strokeWidth={1.75} />
            </RowButton>
            <RowButton label="Drop this ask" onClick={() => set("dropped")}>
              <X className="size-3.5" strokeWidth={1.75} />
            </RowButton>
          </>
        )}
      </div>
    </li>
  );
}

function AddAsk({ sample }: { sample: Ask }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const save = () => {
    const value = text.trim();
    if (value) void askStore().add({ mateId: sample.mateId, sessionId: sample.sessionId, blockId: sample.blockId, text: value }).catch(() => undefined);
    setText("");
    setOpen(false);
  };
  if (!open)
    return (
      <button
        type="button"
        data-ask-add
        onClick={() => setOpen(true)}
        className="ml-2 mt-0.5 flex h-6 items-center gap-1.5 rounded px-1.5 text-xs text-content/60 hover:bg-content/10 hover:text-content"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
        Add one that was missed
      </button>
    );
  return (
    <form
      className="ml-2 mt-1 flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        onBlur={() => (text.trim() ? undefined : setOpen(false))}
        maxLength={400}
        aria-label="The ask that was missed"
        placeholder="What was missed?"
        className="h-7 min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 text-[13px] text-content placeholder:text-content/55 focus:outline focus:outline-1 focus:outline-content/40"
      />
      <button type="submit" className="h-7 rounded-md border border-content/20 px-2 text-xs text-content hover:bg-content/10">
        Add
      </button>
    </form>
  );
}

export function AskReceipt({ blockId }: { blockId: string }) {
  const doc = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [open, setOpen] = useState(false);
  const asks = asksForBlock(doc, blockId);
  // A quiet ask (a lone short ask, answered by the reply) is on the Chief's list but gets no receipt until someone moves it.
  if (!asks.length || asks.every(isQuiet)) return null;
  const waiting = asks.some((ask) => ask.status === "waiting");
  return (
    <div data-ask-receipt={blockId} className="mt-1 w-full max-w-[36rem] font-sans" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-xs text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
        <span>{receiptLine(asks)}</span>
        {waiting ? <span style={{ color: NEEDS_YOU_RED }}>, waiting on you</span> : null}
      </button>
      {open ? (
        <div className="mt-1 rounded-lg border border-stroke py-1 text-left">
          <ul className="m-0 list-none p-0">
            {asks.map((ask) => (
              <Row key={ask.id} ask={ask} />
            ))}
          </ul>
          <AddAsk sample={asks[0]} />
        </div>
      ) : null}
    </div>
  );
}
