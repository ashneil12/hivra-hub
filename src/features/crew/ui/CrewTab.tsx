// Hivra WP-15: the crew, one plain row per worker. No chips, rings, or colour rules.

import { useState } from "react";
import type { CrewTree } from "../model/crewTree";
import type { CrewAction, CrewRow } from "../model/rows";
import { CrewTreeView } from "./CrewTree";

const ACTION_LABEL: Record<CrewAction, string> = {
  open: "Open as a tab",
  message: "Message",
  stop: "Stop",
  retry: "Retry",
  land: "Land",
  "open-pr": "Open the pull request",
};

function diffOf(row: CrewRow): string | null {
  const additions = row.additions ?? 0;
  const deletions = row.deletions ?? 0;
  if (additions === 0 && deletions === 0) return null;
  return [additions ? `+${additions}` : "", deletions ? `−${deletions}` : ""].filter(Boolean).join(" ");
}

function CrewRowView({
  row,
  onOpen,
  onMessage,
  onStop,
  onRetry,
  onDeliver,
}: {
  row: CrewRow;
  onOpen?: (row: CrewRow) => void;
  onMessage?: (row: CrewRow, text: string) => void | Promise<void>;
  onStop?: (row: CrewRow) => void;
  onRetry?: (row: CrewRow) => void;
  onDeliver?: (row: CrewRow) => void;
}) {
  const [messaging, setMessaging] = useState(false);
  const [text, setText] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const [armed, setArmed] = useState(false);
  const diff = diffOf(row);
  const meta = [row.cli, row.model, row.branch, diff, row.checks].filter(Boolean).join(" · ");

  async function send() {
    const body = text.trim();
    if (!body) return;
    try {
      await onMessage?.(row, body);
      setText("");
      setMessaging(false);
      setSendFailed(false);
    } catch {
      // A timeout is not a final loss of what was typed.
      setSendFailed(true);
    }
  }

  return (
    <article data-crew-row={row.id} data-status={row.status ?? "none"} className="border-b border-stroke px-3 py-2">
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] text-content">{row.title}</h3>
        {row.statusWord ? (
          <span data-status-word className="shrink-0 text-[12px] text-content/70">
            {row.statusWord}
          </span>
        ) : null}
        {row.howLong ? <span className="shrink-0 text-[12px] text-content/45">{row.howLong}</span> : null}
      </div>
      {meta ? <p className="mt-0.5 truncate text-[12px] text-content/50">{meta}</p> : null}
      {row.notice ? <p className="mt-0.5 text-[12px] text-content/60">{row.notice}</p> : null}
      {/* WP-141: why the crew picked this worker's CLI, kept on its row. */}
      {row.why ? (
        <p data-crew-why className="mt-0.5 text-[12px] text-content/50">
          {row.why}
        </p>
      ) : null}
      {row.prUrl && row.prNumber != null ? (
        <button
          type="button"
          className="mt-0.5 block text-[12px] text-content/70"
          data-pr={row.id}
          onClick={() => onDeliver?.(row)}
        >
          Pull request #{row.prNumber}
        </button>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {row.actions.map((action) =>
          action === "message" ? (
            <button key={action} type="button" className="text-[12px] text-content/70" onClick={() => setMessaging(true)}>
              {ACTION_LABEL.message}
            </button>
          ) : action === "stop" ? (
            <button key={action} type="button" className="text-[12px] text-content/70" onClick={() => setArmed(true)}>
              {ACTION_LABEL.stop}
            </button>
          ) : action === "retry" ? (
            <button key={action} type="button" className="text-[12px] text-content/70" onClick={() => onRetry?.(row)}>
              {ACTION_LABEL.retry}
            </button>
          ) : (
            <button
              key={action}
              type="button"
              className="text-[12px] text-content/70"
              onClick={() => {
                if (action === "open") onOpen?.(row);
                else onDeliver?.(row);
              }}
            >
              {ACTION_LABEL[action]}
            </button>
          ),
        )}
      </div>
      {messaging ? (
        <form
          className="mt-1.5 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <input
            aria-label={`Message ${row.title}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
          />
          <button type="submit" className="text-[12px] text-content/70">
            {sendFailed ? "Retry" : "Send"}
          </button>
        </form>
      ) : null}
      {armed ? (
        <p className="mt-1.5 flex gap-2 text-[12px] text-content/70">
          <button
            type="button"
            onClick={() => {
              setArmed(false);
              onStop?.(row);
            }}
          >
            Stop it
          </button>
          <button type="button" onClick={() => setArmed(false)}>
            Keep it
          </button>
        </p>
      ) : null}
    </article>
  );
}

export function CrewTab({
  rows,
  briefTitle,
  stale = false,
  note,
  onShowAll,
  onOpen,
  onMessage,
  onStop,
  onRetry,
  onDeliver,
  tree,
  onOpenChat,
}: {
  rows: readonly CrewRow[];
  briefTitle?: string | null;
  stale?: boolean;
  note?: string | null;
  onShowAll?: () => void;
  onOpen?: (row: CrewRow) => void;
  onMessage?: (row: CrewRow, text: string) => void | Promise<void>;
  onStop?: (row: CrewRow) => void;
  onRetry?: (row: CrewRow) => void;
  onDeliver?: (row: CrewRow) => void;
  /** WP-119: the tree sits above the rows. Row actions stay where they are. */
  tree?: CrewTree | null;
  onOpenChat?: (sessionId: string) => void;
}) {
  return (
    <div aria-label="Crew" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {stale ? (
        <p data-crew-stale className="px-3 py-2 text-[12px] text-content/60">
          Couldn't refresh. Trying again.
        </p>
      ) : null}
      {note ? <p className="px-3 py-1 text-[12px] text-content/60">{note}</p> : null}
      {briefTitle ? (
        <p className="flex items-center gap-2 px-3 py-2 text-[12px] text-content/60">
          <span className="min-w-0 flex-1 truncate">{briefTitle}</span>
          <button type="button" onClick={onShowAll}>
            Show everyone
          </button>
        </p>
      ) : null}
      {tree?.root ? <CrewTreeView tree={tree} onOpenChat={onOpenChat} /> : null}
      {rows.length === 0 && !tree?.root ? (
        <p className="px-3 py-3 text-[12px] text-content/50">No one is on this yet.</p>
      ) : null}
      {rows.map((row) => (
        <CrewRowView
          key={row.id}
          row={row}
          onOpen={onOpen}
          onMessage={onMessage}
          onStop={onStop}
          onRetry={onRetry}
          onDeliver={onDeliver}
        />
      ))}
    </div>
  );
}
