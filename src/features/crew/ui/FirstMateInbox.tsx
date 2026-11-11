// Hivra WP-15: decisions, results, failures and credential needs, answered where they sit.

import { waitingPhrase, type FirstMateItem } from "../model/inbox";
import { useEffect, useRef } from "react";

export function FirstMateInbox({
  items,
  stale = false,
  onAnswer,
  onOpenChat,
  onOpenWorker,
  selectedKey = null,
  now,
}: {
  items: readonly FirstMateItem[];
  stale?: boolean;
  onAnswer?: (item: FirstMateItem, answer: string) => void;
  onOpenChat?: (sessionId: string) => void;
  onOpenWorker?: (workerId: string) => void;
  selectedKey?: string | null;
  /** WP-119: the clock the wait phrase is read against. */
  now?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = root.current?.querySelector("[data-selected='true']");
    if (node instanceof HTMLElement && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [selectedKey, items]);
  if (items.length === 0 && !stale) return null;
  return (
    <div ref={root} aria-label="First mate" className="flex flex-col gap-2 px-3 py-2">
      {stale ? <p className="text-[12px] text-content/60">Couldn't refresh. Trying again.</p> : null}
      {items.map((item) => (
        <article
          key={item.id}
          data-inbox-kind={item.kind}
          data-inbox-id={item.id}
          data-decision-key={item.key ?? undefined}
          data-selected={item.key != null && item.key === selectedKey ? "true" : undefined}
          aria-current={item.key != null && item.key === selectedKey ? "true" : undefined}
          className="rounded-md border border-stroke px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
          {item.chip ? (
            <span className="mb-1 inline-flex rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-300">
              {item.chip}
            </span>
          ) : null}
          <h3 className="text-[13px] text-content">{item.title}</h3>
          {item.sourceLine ? <div className="text-[12px] leading-5 text-content/50">{item.sourceLine}</div> : null}
          {typeof now === "number" && waitingPhrase(item.since, now) ? (
            <p data-waiting className="text-[12px] text-content/60">
              {waitingPhrase(item.since, now)}
            </p>
          ) : null}
          {item.statusWord ? <p className="text-[12px] text-content/60">{item.statusWord}</p> : null}
          {item.body ? (
            <p
              data-failure={item.kind === "failure" ? item.id : undefined}
              className="mt-1 whitespace-pre-wrap break-words text-[12px] text-content/70"
            >
              {item.reasonLead ? `${item.reasonLead} ` : null}
              {item.reasonLead ? <span data-reason-text>{item.body}</span> : item.body}
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
          {item.note ? (
            <p data-inbox-note className="mt-1.5 text-[12px] text-content/70">
              {item.note}
            </p>
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
            </div>
            {item.actions?.length ? (
              <div className="flex shrink-0 items-center gap-2">
                {item.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={
                      action.primary
                        ? "rounded-md bg-blue-500 px-2.5 py-1 text-[12px] text-white"
                        : "rounded-md border border-stroke px-2.5 py-1 text-[12px] text-content/80"
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
