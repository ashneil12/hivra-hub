// Hivra WP-15: decisions, results, failures and credential needs, answered where they sit.

import type { FirstMateItem } from "../model/inbox";

export function FirstMateInbox({
  items,
  stale = false,
  onAnswer,
  onOpenChat,
  onOpenWorker,
}: {
  items: readonly FirstMateItem[];
  stale?: boolean;
  onAnswer?: (item: FirstMateItem, answer: string) => void;
  onOpenChat?: (sessionId: string) => void;
  onOpenWorker?: (workerId: string) => void;
}) {
  if (items.length === 0 && !stale) return null;
  return (
    <div aria-label="First mate" className="flex flex-col gap-2 px-3 py-2">
      {stale ? <p className="text-[12px] text-content/60">Couldn't refresh. Trying again.</p> : null}
      {items.map((item) => (
        <article key={item.id} data-inbox-kind={item.kind} data-inbox-id={item.id} className="rounded-md border border-stroke px-3 py-2">
          <h3 className="text-[13px] text-content">{item.title}</h3>
          {item.statusWord ? <p className="text-[12px] text-content/60">{item.statusWord}</p> : null}
          {item.body ? (
            <p data-failure={item.kind === "failure" ? item.id : undefined} className="mt-1 text-[12px] text-content/70">
              {item.body}
            </p>
          ) : null}
          {item.options.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.options.map((option) => (
                <button key={option} type="button" onClick={() => onAnswer?.(item, option)} className="text-[12px] text-content">
                  {option}
                  {item.recommended === option ? <span data-recommended> Recommended</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-2">
            {item.chatId ? (
              <button type="button" className="text-[12px] text-content/60" onClick={() => onOpenChat?.(item.chatId!)}>
                Open the chat
              </button>
            ) : null}
            {item.workerIds.map((id) => (
              <button key={id} type="button" className="text-[12px] text-content/60" onClick={() => onOpenWorker?.(id)}>
                Open the worker
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
