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
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            {item.chip ? (
              <span className="inline-flex shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-300">
                {item.chip}
              </span>
            ) : null}
            <h3 className="text-[13px] text-content">{item.title}</h3>
            {item.marks?.map((mark) => (
              <span
                key={mark}
                className="inline-flex shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[11px] text-content/60"
              >
                {mark}
              </span>
            ))}
          </div>
          {item.sourceLine ? <div className="text-[12px] leading-5 text-content/50">{item.sourceLine}</div> : null}
          {typeof now === "number" && waitingPhrase(item.since, now) ? (
            <p data-waiting className="text-[12px] text-content/60">
              {waitingPhrase(item.since, now)}
            </p>
          ) : null}
          {item.statusWord ? <p className="text-[12px] text-content/60">{item.statusWord}</p> : null}
          <FirstMateAnswerParts item={item} onAnswer={onAnswer} onOpenChat={onOpenChat} onOpenWorker={onOpenWorker} />
            </div>
            {item.actions?.length ? (
              <div className="flex shrink-0 items-center gap-2">
                {item.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => action.onClick?.()}
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

/**
 * The part of a card a person answers from: its body (a secret card's exact command), the answer buttons, the note
 * under them and the links to the chat and the worker. G10: the Inbox's Needs you row for a first mate's decision shows
 * this same part, so the decision is answered there and not on a second card.
 */
export function FirstMateAnswerParts({
  item,
  onAnswer,
  onOpenChat,
  onOpenWorker,
}: {
  item: FirstMateItem;
  onAnswer?: (item: FirstMateItem, answer: string) => void;
  onOpenChat?: (sessionId: string) => void;
  onOpenWorker?: (workerId: string) => void;
}) {
  return (
    <>
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
            // The same answer rows the Needs you card uses (Ash, 13 Nov), small: bordered, the pick lit and marked.
            <button
              key={option}
              type="button"
              onClick={() => onAnswer?.(item, option)}
              className={`inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[12px] text-content transition-[background-color,transform] duration-[120ms] ease-[var(--motion-ease-out)] active:scale-[0.98] motion-reduce:transition-none ${
                item.recommended === option ? "border-content/20 bg-content/5 hover:bg-content/8" : "border-content/10 hover:border-content/20 hover:bg-content/5"
              }`}
            >
              {option}
              {item.recommended === option ? <span data-recommended className="text-[11px] text-content/60"> Recommended</span> : null}
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
    </>
  );
}
