// One main chat (Ash, 13 Nov: "i like a"): the Chief of Staff's chat carries three chips beside its own buttons, each
// opening over the chat. Needs you is the Inbox's own list and card; You asked is the ask ledger (asks/model/asks.ts, the
// one ledger the first mates work on, read through askedView.ts), so nothing he asked for is lost in a long chat and what
// a first mate or a finished job says about an ask shows here; Working is every job in every project, with the way in to
// take one over.
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { NEEDS_YOU_RED } from "../../hub/ui/StatusMark";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { CircleWord } from "../../hub/ui/StatusMark";
import { openFromHome } from "../../home/model/opener";
import { findMono } from "../../monos/model/mono";
import { handBack, hasJumpedIn, useDelegationRows, useDelegationsVersion } from "../../monos/model/delegationStore";
import { InboxNeeds } from "../../needs/ui/InboxNeeds";
import { NeedDetail, useShownNeed } from "../../needs/ui/NeedDetail";
import { useNeedsYou } from "../../needs/model/needsLive";
import { askStore } from "../model/askStore";
import { askedOpenCount, askedRows, type AskedRow } from "../model/askedView";
import { JOB_WORD, jobGroups, jobStatus, openJobCount } from "../model/chiefJobs";

const subscribeAsks = (fn: () => void): (() => void) => askStore().subscribe(fn);
const asksNow = () => askStore().doc();

/** The asks he made that are still on the list (dropped ones are gone), newest first. */
function useAsked(): AskedRow[] {
  const doc = useSyncExternalStore(subscribeAsks, asksNow, asksNow);
  return useMemo(() => askedRows(doc), [doc]);
}

const HINT = "px-2 py-2 text-[12px] leading-4 text-content/60";
const QUIET = "shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";

export function useChiefCounts(): { needs: number; asked: number; working: number } {
  const needs = useNeedsYou().length;
  const asked = askedOpenCount(useAsked());
  const working = openJobCount(useDelegationRows());
  return { needs, asked, working };
}

/** The one Needs you list, answered where it is: a row opens its card under the list. */
export function ChiefNeeds() {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useShownNeed(picked, false);
  const count = useNeedsYou().length;
  return (
    <div data-chief-needs className="-mx-2 -my-2 flex flex-col">
      {count === 0 ? <p className={`${HINT} px-4 pt-3`}>Nothing needs you right now.</p> : null}
      <InboxNeeds pick={{ picked, onPick: (item) => setPicked(item.key === picked ? null : item.key) }} />
      {shown ? <NeedDetail item={shown} /> : count ? <p className={`${HINT} px-4`}>Tap a row to see what was asked and answer it here.</p> : null}
    </div>
  );
}

/** Everything the owner asked for, newest first: still open, working, done (with what closed it) or waiting on him. */
export function ChiefAsked() {
  const asked = useAsked();
  if (asked.length === 0) return <p className={HINT}>What you ask for shows here, so nothing gets lost in a long chat.</p>;
  return (
    <ul data-chief-asked className="flex flex-col">
      {asked.map((item, index) => (
        <li key={item.id} data-asked={item.open ? "open" : "handled"} data-asked-status={item.status} className={`flex items-start gap-2 px-2 py-2${index ? " border-t border-stroke" : ""}`}>
          <span className="mt-0.5">
            <CircleWord circle={item.red ? "red" : "grey"} word={item.word} ringOnly />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`text-[13px] leading-[18px] ${item.open ? "text-content" : "text-content/60"}`}>{item.title}</span>
            <span className="text-[11px] leading-4 text-content/60">
              {item.word}
              {item.said ? ` · said ${item.said} times` : ""}
              {item.note ? ` · ${item.note}` : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Every job in every project, grouped by project, with the way in to take one over. */
export function ChiefWorking() {
  useHubDataVersion();
  useDelegationsVersion();
  const rows = useDelegationRows();
  const groups = jobGroups(rows, hubData().listProjects());
  if (groups.length === 0) return <p className={HINT}>Nothing running right now.</p>;
  return (
    <div data-chief-working className="flex flex-col gap-3">
      {groups.map(({ projectId, name, rows: list }) => {
        const lead = list.map((row) => (row.ownerMono ? findMono(row.ownerMono)?.name : undefined)).find(Boolean);
        return (
          <section key={projectId ?? "none"} aria-label={name} className="flex flex-col">
            <h3 className="flex items-baseline gap-1.5 px-2 pb-1 text-[12px] leading-5">
              <span className="font-medium text-content">{name}</span>
              <span className="text-content/60">
                {lead ? `${lead} · ` : ""}
                {list.length} {list.length === 1 ? "job" : "jobs"}
              </span>
            </h3>
            <ul className="flex flex-col">
              {list.map((row) => {
                const status = jobStatus(row) ?? "working";
                const red = status === "needs-you";
                const word = JOB_WORD[status];
                const mine = hasJumpedIn(row.childSession);
                // The job's own first mate, not the first one in the project.
                const owner = row.ownerMono ? findMono(row.ownerMono)?.name : undefined;
                return (
                  <li key={row.id} data-chief-job={row.id} className="group flex items-start gap-2 border-t border-stroke px-2 py-1.5">
                    <span className="mt-0.5">
                      <CircleWord circle={red ? "red" : "grey"} word={word} ringOnly />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] leading-[18px] text-content">{row.title ?? row.goal ?? "Untitled work"}</span>
                      <span className="truncate text-[11px] leading-4 text-content/60">
                        {mine ? "You're driving this one" : (row.statusNotice ?? word)}
                      </span>
                    </span>
                    {mine ? (
                      <button type="button" data-hand-back className={QUIET} aria-label={`Hand ${row.title ?? "this job"} back${owner ? ` to ${owner}` : ""}`} onClick={() => handBack(row.childSession)}>
                        Hand back{owner ? ` to ${owner}` : ""}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-take-over
                        className={`${QUIET} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
                        aria-label={`Open ${row.title ?? "this job"}`}
                        onClick={() => {
                          openFromHome({ kind: "chat", id: row.childSession, projectId: row.project ?? "" });
                        }}
                      >
                        Open
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The three lists as chips beside the chat's own buttons, each opening over the chat. */
export function ChiefChips() {
  const counts = useChiefCounts();
  const [open, setOpen] = useState<"needs" | "asked" | "working" | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const chips = [
    { id: "needs" as const, label: "Needs you", count: counts.needs },
    { id: "asked" as const, label: "You asked", count: counts.asked },
    { id: "working" as const, label: "Working", count: counts.working },
  ];
  return (
    <div ref={anchor} data-chief-chips className="flex items-center gap-1" data-tauri-drag-region="false">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          aria-pressed={open === chip.id}
          data-chief-chip={chip.id}
          onClick={() => setOpen(open === chip.id ? null : chip.id)}
          className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] ${
            open === chip.id ? "bg-content/10 text-content" : "bg-content/5 text-content/70 hover:bg-content/8 hover:text-content"
          }`}
        >
          {chip.label}
          <span className="tabular-nums" style={chip.id === "needs" && chip.count ? { color: NEEDS_YOU_RED } : undefined}>
            {chip.count}
          </span>
        </button>
      ))}
      {open ? (
        <Popover anchor={anchor} side="bottom" align="end" width={440} maxHeight={620} onDismiss={() => setOpen(null)} role="dialog" aria-label={chips.find((chip) => chip.id === open)?.label} ignore="[data-chief-chips]" className="solid-panel-glass font-sans">
          <div className="max-h-[600px] overflow-y-auto px-2 py-2">{open === "needs" ? <ChiefNeeds /> : open === "asked" ? <ChiefAsked /> : <ChiefWorking />}</div>
        </Popover>
      ) : null}
    </div>
  );
}
