// One main chat (Ash, 13 Nov: "i like a"): the Chief of Staff's chat carries three chips beside its own buttons, each
// opening over the chat. Needs you is the Inbox's own list and card; You asked is the ask ledger (hub/model/askLedger.ts),
// so nothing he asked for is lost in a long chat; Working is every job in every project, with the way in to take one over.
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
import { readAskLedger, subscribeAskLedger, type LedgerAsk } from "../../hub/model/askLedger";

let ledgerVersion = 0;
subscribeAskLedger(() => {
  ledgerVersion += 1;
});

/** The asks he made that are still on the list (dropped ones are gone), newest first. */
function useAsked(): LedgerAsk[] {
  const version = useSyncExternalStore(subscribeAskLedger, () => ledgerVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readAskLedger().filter((row) => row.status !== "dropped").reverse(), [version]);
}

const ASKED_WORD: Record<LedgerAsk["status"], string> = { open: "Open", handled: "Done", parked: "Set aside", dropped: "Dropped" };

const HINT = "px-2 py-2 text-[12px] leading-4 text-content/60";
const QUIET = "shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content";

export function useChiefCounts(): { needs: number; asked: number; working: number } {
  const needs = useNeedsYou().length;
  const asked = useAsked().filter((item) => item.status === "open").length;
  const working = useDelegationRows().filter((row) => row.state === "running").length;
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

/** Everything the owner asked for, newest first: still open, done (with what closed it) or set aside. */
export function ChiefAsked() {
  const asked = useAsked();
  if (asked.length === 0) return <p className={HINT}>What you ask for shows here, so nothing gets lost in a long chat.</p>;
  return (
    <ul data-chief-asked className="flex flex-col">
      {asked.map((item, index) => {
        const note = item.status === "handled" ? item.evidence : item.gap;
        return (
          <li key={item.id} data-asked={item.status} className={`flex items-start gap-2 px-2 py-2${index ? " border-t border-stroke" : ""}`}>
            <span className="mt-0.5">
              <CircleWord circle={item.status === "open" && item.gap ? "red" : "grey"} word={ASKED_WORD[item.status]} ringOnly />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`text-[13px] leading-[18px] ${item.status === "open" ? "text-content" : "text-content/60"}`}>{item.title}</span>
              <span className="text-[11px] leading-4 text-content/60">
                {ASKED_WORD[item.status]}
                {item.said && item.said > 1 ? ` · said ${item.said} times` : ""}
                {note ? ` · ${note}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Every job in every project, grouped by project, with the way in to take one over. */
export function ChiefWorking() {
  useHubDataVersion();
  useDelegationsVersion();
  const rows = useDelegationRows();
  const projects = hubData().listProjects();
  const groups = projects
    .map((project) => ({ project, rows: rows.filter((row) => row.project === project.id) }))
    .filter((group) => group.rows.length > 0);
  if (groups.length === 0) return <p className={HINT}>Nothing running right now.</p>;
  return (
    <div data-chief-working className="flex flex-col gap-3">
      {groups.map(({ project, rows: list }) => {
        const lead = list.map((row) => (row.ownerMono ? findMono(row.ownerMono)?.name : undefined)).find(Boolean);
        return (
          <section key={project.id} aria-label={project.name} className="flex flex-col">
            <h3 className="flex items-baseline gap-1.5 px-2 pb-1 text-[12px] leading-5">
              <span className="font-medium text-content">{project.name}</span>
              <span className="text-content/60">
                {lead ? `${lead} · ` : ""}
                {list.length} {list.length === 1 ? "job" : "jobs"}
              </span>
            </h3>
            <ul className="flex flex-col">
              {list.map((row) => {
                const red = row.status === "needs-you" || row.state === "failed" || row.state === "question";
                const word = red ? "Needs you" : row.state === "running" ? "Working" : row.state === "completed" ? "Done" : "Stopped";
                const mine = hasJumpedIn(row.childSession);
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
                      <button type="button" data-hand-back className={QUIET} aria-label={`Hand ${row.title ?? "this job"} back${lead ? ` to ${lead}` : ""}`} onClick={() => handBack(row.childSession)}>
                        Hand back{lead ? ` to ${lead}` : ""}
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
