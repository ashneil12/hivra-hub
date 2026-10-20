import { useState, type ReactNode } from "react";
import { hubData } from "../model/hubData";
import type { Need } from "../model/types";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-60";
const PAGE = 25;

/** "Dismiss all older than": the choices, in days. */
export const OLDER_THAN = [
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
] as const;

/** Open older questions asked more than `days` ago (a row with no date counts as old). */
export function olderThan(rows: readonly Need[], days: number, now = Date.now()): Need[] {
  const cut = now - days * 86_400_000;
  return rows.filter((n) => n.state !== "done" && (!n.since || Date.parse(n.since) < cut));
}

/**
 * The retired question queue, kept as one quiet line at the bottom of Today: "Older questions (N)". Agents now ask in
 * their own chats (Waiting on you), so nothing new joins it. Opened, Ash can sweep it: answer any row (its usual sheet),
 * or dismiss everything older than a few days in one go (their asks are parked, never dropped). It is in no badge.
 */
export function OlderQuestions({ projectId, renderRow }: { projectId: string | undefined; renderRow: (need: Need) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [days, setDays] = useState<number>(OLDER_THAN[0].days);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const data = hubData();
  const all = data.listOlder(projectId);
  // A row answered from here stays (ticked, with its receipt) until Ash leaves; one closed elsewhere just goes.
  const rows = all.filter((n) => n.state !== "done" || data.answerState?.(n.id));
  const openCount = all.filter((n) => n.state !== "done").length;
  if (!openCount && !receipt) return null;
  const names = new Map(data.listProjects().map((p) => [p.id, p.name]));
  const page = rows.slice(0, shown);
  const groups = [...new Set(page.map((n) => n.projectId))];
  const sweep = olderThan(all, days);
  const dismiss = async () => {
    if (!data.dismissOlder) return;
    setBusy(true);
    try {
      setReceipt((await data.dismissOlder(days, projectId)).receipt);
    } catch (e) {
      setReceipt(e instanceof Error ? e.message : "That didn't go through.");
    }
    setBusy(false);
    setConfirming(false);
  };
  return (
    <section data-hub-older>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="rounded-md px-2 text-xs text-content/60 hover:text-content">
        Older questions ({openCount})
      </button>
      {open ? (
        <div className="mt-1 flex flex-col">
          <p className="px-2 pb-1 text-[13px] leading-5 text-content/60" data-hub-older-note>
            From the old question queue. Agents ask in their own chats now, so nothing new is added here.
          </p>
          {data.dismissOlder && openCount ? (
            <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-[13px] text-content/70" data-hub-older-sweep>
              <label className="flex items-center gap-2">
                Dismiss all older than
                <select
                  value={days}
                  onChange={(e) => {
                    setDays(Number(e.target.value));
                    setConfirming(false);
                  }}
                  aria-label="Older than"
                  className="rounded-md bg-content/8 px-2 py-1 text-[13px] text-content outline-none"
                >
                  {OLDER_THAN.map((o) => (
                    <option key={o.days} value={o.days}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {confirming ? (
                <>
                  <button type="button" className={BTN} disabled={busy} onClick={() => void dismiss()} data-hub-older-confirm>
                    {busy ? "Dismissing…" : `Yes, dismiss ${sweep.length}`}
                  </button>
                  <button type="button" className="rounded-md px-2 py-1 text-xs text-content/60 hover:text-content" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <span className="basis-full text-[12px] text-content/50">Their asks are parked, not dropped: saying one again brings it back.</span>
                </>
              ) : (
                <button type="button" className={BTN} disabled={!sweep.length} onClick={() => setConfirming(true)} data-hub-older-dismiss>
                  Dismiss {sweep.length}
                </button>
              )}
            </div>
          ) : null}
          {receipt ? <p className="px-2 py-1 text-[13px] text-content/85" data-hub-older-receipt>{receipt}</p> : null}
          {groups.map((pid) => (
            <div key={pid} className="flex flex-col">
              {projectId ? null : <h2 className="mb-1 mt-2 px-2 text-xs text-content/60">{names.get(pid) ?? pid}</h2>}
              {page.filter((n) => n.projectId === pid).map((n) => renderRow(n))}
            </div>
          ))}
          {rows.length > shown ? (
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="mt-2 self-start rounded-md bg-content/5 px-3 py-1.5 text-[12px] text-content/70" data-hub-older-more>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
