import { useEffect, useMemo, useRef } from "react";
import type { FirstMateFold } from "../../crew/ui/FirstMateInboxPanel";
import { FirstMateAnswerParts } from "../../crew/ui/FirstMateInbox";
import { isSecretDecisionKey } from "../../hub/model/decisionKey";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { needActions } from "../../home/model/needActions";
import { needTarget } from "../../home/model/needTarget";
import { needsRank } from "../../home/model/needsShown";
import { openFromHome } from "../../home/model/opener";
import { foldFirstMate } from "../model/inboxFold";
import { projectIdOf, useNeedsYou } from "../model/needsLive";
import type { NeedsItem } from "../model/needsYou";

/** Every row, most urgent first (Home's order), not Home's first five. */
export function inboxNeedsOrder(items: readonly NeedsItem[]): NeedsItem[] {
  return [...items].sort((a, b) => needsRank(a) - needsRank(b) || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Dropwave (Ash, 11 Nov: "does the Inbox work with asks and things that need doing?"): the one Needs you list at the
 * top of the Inbox, above the work items from GitHub and the other connections. The same rows Home shows and the red
 * count beside Inbox counts, each with its own one-tap answer; a row opens the place it names.
 *
 * G10: with `firstMate` (the first-mate panel's fold), a first mate's decision is one row here: the row shows that
 * decision's answer buttons (and a secret card's exact command), and they run the panel's versioned answer.
 */
export function InboxNeeds({ firstMate = null }: { firstMate?: FirstMateFold | null } = {}) {
  useHubDataVersion();
  const needs = useNeedsYou();
  const ordered = useMemo(() => inboxNeedsOrder(needs), [needs]);
  const projects = hubData().listProjects();
  const refs = projects.map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null }));
  const rows = foldFirstMate(ordered, firstMate?.decisions ?? [], (path) => projectIdOf(path, refs));
  const selected = firstMate?.selectedKey ?? null;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const node = list.current?.querySelector("[data-selected='true']");
    if (node instanceof HTMLElement && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);
  if (rows.length === 0) return null;
  const many = projects.length > 1;
  return (
    <section aria-label="Needs you" data-inbox-needs={rows.length} className="flex flex-col gap-1 border-b border-stroke px-1.5 pb-2 pt-2">
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
            const chosen = decision.key != null && decision.key === selected;
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
                  <button type="button" className="flex min-w-0 flex-col gap-0.5 text-left" onClick={() => openFromHome(needTarget(item))}>
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
              </li>
            );
          }
          if (!item) return null;
          const project = many && item.projectId ? projects.find((p) => p.id === item.projectId)?.name : undefined;
          const action = needActions(item)[0];
          return (
            <li key={key} data-inbox-need={item.kind} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-content/5">
              <button type="button" className="flex min-w-0 flex-1 flex-col gap-0.5 text-left" onClick={() => openFromHome(needTarget(item))}>
                <span className="text-[13px] leading-[18px] text-content">{item.sentence}</span>
                <span className="truncate text-[11px] leading-4 text-content/55">{[project, item.who].filter(Boolean).join(" · ")}</span>
              </button>
              {action ? (
                <button
                  type="button"
                  title={action.title ?? action.label}
                  aria-label={action.title ?? action.label}
                  data-needs-answer=""
                  onClick={action.onClick}
                  className="mt-0.5 shrink-0 rounded-md border border-content/20 px-2 py-0.5 text-[12px] text-content hover:bg-content/8"
                >
                  {action.label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
