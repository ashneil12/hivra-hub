// Shelves, the undo notice, and the snooze time for the optional chat list inbox.
import { useState } from "react";
import { parseSnoozeChoice } from "../model/chatListInbox";
import { undoInbox, useInboxNotice } from "../model/chatListInboxStore";

export type InboxShelfRow = { id: string; title: string };

function Shelf({
  label,
  rows,
  action,
  onOpen,
  onAction,
  marker,
}: {
  label: string;
  rows: readonly InboxShelfRow[];
  action: string;
  onOpen: (id: string) => void;
  onAction: (id: string) => void;
  marker: "settled" | "snoozed";
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <section className="mt-2 px-2" {...{ [`data-${marker}-shelf`]: "" }}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[13px] text-content/80 hover:bg-content/5"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <span className="text-content/45">{rows.length}</span>
      </button>
      {open ? (
        <ul className="m-0 list-none p-0">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-1 px-2 py-0.5" data-shelf-row={row.id}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[13px] text-content"
                onClick={() => onOpen(row.id)}
              >
                {row.title}
              </button>
              <button
                type="button"
                className="shrink-0 text-[12px] text-content/70 hover:text-content"
                onClick={() => onAction(row.id)}
              >
                {action}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ChatListShelves({
  settled,
  snoozed,
  onOpen,
  onUnsettle,
  onUnsnooze,
}: {
  settled: readonly InboxShelfRow[];
  snoozed: readonly InboxShelfRow[];
  onOpen: (id: string) => void;
  onUnsettle: (id: string) => void;
  onUnsnooze: (id: string) => void;
}) {
  if (settled.length === 0 && snoozed.length === 0) return null;
  return (
    <>
      <Shelf label="Settled" rows={settled} action="Unsettle" onOpen={onOpen} onAction={onUnsettle} marker="settled" />
      <Shelf label="Snoozed" rows={snoozed} action="Unsnooze" onOpen={onOpen} onAction={onUnsnooze} marker="snoozed" />
    </>
  );
}

export function ChatListInboxNotice() {
  const notice = useInboxNotice();
  if (!notice) return null;
  return (
    <div data-inbox-notice className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-md bg-content/5 px-2 py-1.5 text-[13px] text-content">
      <p role="status" aria-live="polite" aria-atomic="true" className="m-0 min-w-0">
        {notice.sr}
      </p>
      <button type="button" className="shrink-0 text-content/80 hover:text-content" onClick={() => undoInbox()}>
        Undo
      </button>
    </div>
  );
}

export function SnoozeTimeDialog({
  onSnooze,
  onClose,
}: {
  onSnooze: (until: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      data-snooze-dialog
      className="mx-2 mt-2 rounded-md border border-stroke p-2 text-[13px] text-content"
      onSubmit={(event) => {
        event.preventDefault();
        const until = parseSnoozeChoice(value, Date.now());
        if (until == null) {
          setError("Pick a time in the future.");
          return;
        }
        onSnooze(until);
      }}
    >
      <label className="flex flex-col gap-1">
        Snooze until
        <input
          type="datetime-local"
          value={value}
          className="rounded-md border border-stroke bg-transparent px-2 py-1"
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
        />
      </label>
      {error ? <p className="m-0 mt-1 text-content/70">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="submit" className="rounded-md bg-content/10 px-2 py-1">
          Snooze
        </button>
        <button type="button" className="px-2 py-1 text-content/70" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
