import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChevronRight } from "../../../shared/ui/icons";
import type { FirstMateFold } from "../../crew/ui/FirstMateInboxPanel";
import { FirstMateAnswerParts } from "../../crew/ui/FirstMateInbox";
import { isSecretDecisionKey } from "../../hub/model/decisionKey";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { needsRank } from "../../home/model/needsShown";
import { foldFirstMate } from "../model/inboxFold";
import { askedAgo, NEED_KIND_LABEL, openNeed, shownNeed } from "../model/needContext";
import { projectIdOf, useNeedsYou } from "../model/needsLive";
import type { NeedsItem } from "../model/needsYou";
import { dismissNeed, letGoDecisionKeys, type DropRow } from "../model/settledNeeds";
import { FinishedNeeds } from "./FinishedNeeds";
import { OneTapNotice } from "./OneTapNotice";
import { Reveal } from "./Reveal";

/** Every row, most urgent first (Home's order), not Home's first five. */
export function inboxNeedsOrder(items: readonly NeedsItem[]): NeedsItem[] {
  return [...items].sort((a, b) => needsRank(a) - needsRank(b) || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * How a row opens its card beside the list: the open one, whether the first is open when none is, and the pick. With
 * `renderOpen` the card opens under its own row instead (the Chief of Staff's Needs you list), sliding open.
 */
export type InboxNeedsPick = {
  picked: string | null;
  firstWhenNone?: boolean;
  onPick: (item: NeedsItem) => void;
  renderOpen?: (item: NeedsItem) => ReactNode;
};

/** What a row says under its ask: who asked, then how many answers it offers and the asker's pick. */
export function needSummary(item: Pick<NeedsItem, "choices" | "suggested" | "answer" | "actions">): string {
  const count = item.answer ? (item.choices?.length ?? 0) : 0;
  if (count > 1) return `${count} answers${item.suggested ? ` · Suggested: ${item.suggested}` : ""}`;
  const tap = item.actions.find((action) => action.label !== "Open" && action.label !== "Open chat");
  return tap ? `Suggested: ${tap.title ?? tap.label}` : "";
}

/** A real time, not a fact that never had one (a parked check carries 0). */
function shownAgo(at: number, now: number): string {
  return at > 1_000_000_000_000 ? askedAgo(at, now) : "";
}

/**
 * Dropwave (Ash, 11 Nov: "does the Inbox work with asks and things that need doing?"): the one Needs you list at the
 * top of the Inbox, above the work items from GitHub and the other connections. The same rows Home shows and the red
 * count beside Inbox counts, each with its own one-tap answer; a row opens the place it names.
 *
 * G10: with `firstMate` (the first-mate panel's fold), a first mate's decision is one row here: the row shows that
 * decision's answer buttons (and a secret card's exact command), and they run the panel's versioned answer.
 *
 * With `onPick` (Ash, 11 Nov: a row "doesn't actually bring me to anything"), a row's words open its card beside the
 * list instead of leaving the Inbox; `picked` is the open one, and with `firstWhenNone` the first row is.
 */
export function InboxNeeds({
  firstMate = null,
  pick,
  onQuote,
  now = Date.now(),
}: {
  firstMate?: FirstMateFold | null;
  pick?: InboxNeedsPick;
  /** Quote a row into the chat (Ash, 13 Nov): a quiet Quote on each row, shown on hover or focus. */
  onQuote?: (item: NeedsItem, project?: string) => void;
  now?: number;
} = {}) {
  useHubDataVersion();
  const needs = useNeedsYou();
  const ordered = useMemo(() => inboxNeedsOrder(needs), [needs]);
  const projects = hubData().listProjects();
  const refs = projects.map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null }));
  const rows = foldFirstMate(ordered, firstMate?.decisions ?? [], (path) => projectIdOf(path, refs), letGoDecisionKeys());
  const selected = firstMate?.selectedKey ?? null;
  const open = pick ? shownNeed(ordered, pick.picked, pick.firstWhenNone ?? false)?.key : undefined;
  const openRow = (item: NeedsItem) => (pick ? pick.onPick(item) : openNeed(item));
  // The decision Home led here for opens its card too, so the row a person came for is the one beside the list.
  const led = pick && selected ? rows.find((row) => row.decision?.key === selected)?.need : undefined;
  const ledKey = led?.key;
  const onPick = pick?.onPick;
  useEffect(() => {
    if (led && onPick) onPick(led);
    // Only when Home leads to another decision, not each time the list is read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledKey]);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const node = list.current?.querySelector("[data-selected='true']");
    if (node instanceof HTMLElement && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);
  if (rows.length === 0) {
    return (
      <>
        <OneTapNotice />
        {pick?.firstWhenNone ? (
          <p data-inbox-needs-empty className="px-3 py-3 text-[12px] text-content/50">
            Nothing is asking for an answer.
          </p>
        ) : null}
        <FinishedNeeds className="px-1.5" />
      </>
    );
  }
  const many = projects.length > 1;
  return (
    <section aria-label="Needs you" data-inbox-needs={rows.length} className="flex flex-col gap-1 border-b border-stroke px-1.5 pb-2 pt-2">
      <OneTapNotice />
      <h2 className="flex items-center gap-1.5 px-1.5 text-xs leading-5 text-content/60">
        <span className="size-1.5 rounded-full" style={{ background: NEEDS_YOU_RED }} />
        Needs you
        <span className="text-content/45">{rows.length}</span>
      </h2>
      <ul ref={list} className="flex flex-col gap-0.5">
        {rows.map(({ key, need: item, decision }) => {
          if (decision && firstMate) {
            const projectId = item?.projectId ?? projectIdOf(decision.project, refs);
            const project = many && projectId ? projects.find((p) => p.id === projectId)?.name : undefined;
            // A secret card is the exact command the person approves, never the row's shortened sentence.
            const sentence = item && !isSecretDecisionKey(decision.key ?? "") ? item.sentence : decision.title;
            const meta = [project, item?.who].filter(Boolean).join(" · ");
            // With a card open beside the list, the lit row is that card's; else the decision Home led here for.
            const chosen = open ? item?.key === open : decision.key != null && decision.key === selected;
            // A first mate's decision row has no done tick, so the row carries his own drop (Ash, 13 Nov: "there's a
            // lot of ones that I can't actually tick as done ... when they resolve, they can just go into their own
            // pile"). The decision's key is carried so it stops drawing a row (`letGoDecisionKeys`).
            const dropRow: DropRow = {
              // The Needs you row's own key when it drew this decision: finished rows hide that row everywhere, not
              // only in this folded list. A decision with no Needs row yet falls back to its own key.
              key: item?.key ?? decision.key ?? decision.id,
              kind: "question",
              sentence,
              who: decision.sourceLine ?? "The lead",
              projectId: decision.project,
              ...(decision.key ? { decisionKey: decision.key } : {}),
            };
            return (
              <li
                key={key}
                data-inbox-need={item?.kind ?? "question"}
                data-decision-key={decision.key ?? undefined}
                data-selected={chosen ? "true" : undefined}
                aria-current={chosen ? "true" : undefined}
                className={`flex flex-col rounded-lg px-1.5 py-1.5 hover:bg-content/5${chosen ? " bg-content/5" : ""}`}
              >
                {item ? (
                  <button type="button" className="flex min-w-0 flex-col gap-0.5 text-left" onClick={() => openRow(item)}>
                    <span className="text-[13px] leading-[18px] text-content">{sentence}</span>
                    {meta ? <span className="truncate text-[11px] leading-4 text-content/55">{meta}</span> : null}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] leading-[18px] text-content">{sentence}</span>
                    {meta ? <span className="truncate text-[11px] leading-4 text-content/55">{meta}</span> : null}
                  </div>
                )}
                <FirstMateAnswerParts
                  item={decision}
                  onAnswer={firstMate.answer}
                  onOpenChat={firstMate.openChat}
                  onOpenWorker={firstMate.openWorker}
                />
                <button
                  type="button"
                  data-let-go-need
                  aria-label={`Let it go: ${sentence}`}
                  onClick={() => dismissNeed(dropRow)}
                  className="mt-1.5 self-start rounded-md px-2 py-0.5 text-[12px] leading-4 text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
                >
                  Let it go
                </button>
              </li>
            );
          }
          if (!item) return null;
          const project = item.projectId ? projects.find((p) => p.id === item.projectId)?.name : undefined;
          const chosen = item.key === open;
          const inline = chosen && pick?.renderOpen ? pick.renderOpen(item) : null;
          const summary = needSummary(item);
          const ago = shownAgo(item.at, now);
          // A question he cannot tick done is finished from its own row (Ash, 13 Nov): "Let it go" is his own drop.
          const finishable = item.kind === "question";
          return (
            <li
              key={key}
              data-inbox-need={item.kind}
              data-need-key={item.key}
              data-selected={chosen ? "true" : undefined}
              className="flex min-w-0 flex-col"
            >
              <div className="group/need relative flex min-w-0 items-stretch">
                <button
                  type="button"
                  aria-current={chosen ? "true" : undefined}
                  aria-expanded={pick?.renderOpen ? chosen : undefined}
                  aria-label={`${NEED_KIND_LABEL[item.kind]}${project ? `, ${project}` : ""}: ${item.sentence}. Open to answer.`}
                  onClick={() => openRow(item)}
                  // Laid out like the Inbox's own pull request rows (Ash, 13 Nov): the kind and project on a quiet line
                  // with the time, the ask in bold, then who asked and what it offers. The arrow says it opens.
                  className={`flex w-full min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-[120ms] ease-[var(--motion-ease-out)] ${
                    chosen ? "bg-selection" : "hover:bg-content/5"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-content/55">
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: NEEDS_YOU_RED }} />
                    <span className="min-w-0 truncate">
                      {NEED_KIND_LABEL[item.kind]}
                      {many && project ? ` · ${project}` : ""}
                    </span>
                    {ago ? (
                      <span
                        className={`ml-auto shrink-0 tabular-nums text-content/50 ${onQuote || finishable ? "group-focus-within/need:opacity-0 group-hover/need:opacity-0" : ""}`}
                      >
                        {ago}
                      </span>
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-content">{item.sentence}</span>
                  {item.detail ? (
                    <span data-need-line className="line-clamp-2 text-[12px] leading-4 text-content/70">
                      {item.detail}
                    </span>
                  ) : null}
                  <span data-need-summary className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-content/55">
                    <span className="min-w-0 truncate">{[item.who, summary].filter(Boolean).join(" · ")}</span>
                    <ChevronRight
                      aria-hidden
                      className={`ml-auto size-3.5 shrink-0 text-content/50 transition-transform duration-200 ease-[var(--motion-ease-out)] motion-reduce:transition-none ${
                        pick?.renderOpen && chosen ? "rotate-90" : ""
                      }`}
                      strokeWidth={1.75}
                    />
                  </span>
                </button>
                {onQuote || finishable ? (
                  // Over the row's time, top right, only on hover or focus: the row keeps its full width.
                  <div className="absolute right-1.5 top-1 flex items-center gap-1 opacity-0 focus-within:opacity-100 group-hover/need:opacity-100">
                    {finishable ? (
                      <button
                        type="button"
                        data-let-go-need={item.key}
                        aria-label={`Let it go: ${item.sentence}`}
                        onClick={() => dismissNeed(item)}
                        className="rounded-md px-1.5 py-0.5 text-[12px] leading-4 text-content/70 hover:bg-content/8 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
                      >
                        Let it go
                      </button>
                    ) : null}
                    {onQuote ? (
                      <button
                        type="button"
                        data-quote-need={item.key}
                        aria-label={`Quote in the chat: ${item.sentence}`}
                        onClick={() => onQuote(item, project)}
                        className="rounded-md px-1.5 py-0.5 text-[12px] leading-4 text-content/70 hover:bg-content/8 hover:text-content focus-visible:outline focus-visible:outline-1 focus-visible:outline-content/40"
                      >
                        Quote
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {inline ? <Reveal>{inline}</Reveal> : null}
            </li>
          );
        })}
      </ul>
      <FinishedNeeds className="px-1.5" />
    </section>
  );
}
