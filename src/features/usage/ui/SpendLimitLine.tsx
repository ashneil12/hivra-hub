// WP-176. One line for a measured-cost limit: a project's on the project Workers dialog and Settings > Crew, and the
// whole app's on Settings. Nothing here stops a builder that is already running. Blank means no limit.
// Only the person changes a limit here. A first mate's chat can only lower one (see the gate).

import { useState, useSyncExternalStore } from "react";
import {
  clearSpendLimit,
  replaceUnreadableSpendStore,
  saveSpendLimit,
  spendFor,
  spendLine,
  spendSnapshot,
  spendUnreadable,
  subscribeSpend,
} from "../model/spendGate";
import type { SpendPeriod } from "../model/spend";
import { parseDollars } from "../model/money";

const UNSET = "No spend limit is set.";
const BAD_AMOUNT = "Enter a dollar amount such as 50 or 12.50.";

/** The limit for this period, for a project, or the whole app when `scope` is "app". */
export function SpendLimitLine({
  project,
  harness = "claude",
  indexed = false,
  scope = "project",
}: {
  project: string;
  harness?: string;
  /** Settings search lands on this line. The project dialog leaves it off. */
  indexed?: boolean;
  scope?: "project" | "app";
}) {
  const revision = useSyncExternalStore(subscribeSpend, () => spendSnapshot().book.revision, () => 0);
  const [period, setPeriod] = useState<SpendPeriod>("month");
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const unreadable = spendUnreadable();
  const who = scope === "app" ? "" : project;
  const mine = spendFor(who).find((row) => row.scope === scope && row.period === period);
  const text = spendLine(who, harness, scope);
  const field = draft ?? (mine ? String(mine.amountUsd) : "");
  const canEdit = scope === "app" || project.trim() !== "";
  const label = scope === "app" ? "Whole-app limit" : "Measured cost limit";

  const commit = (raw: string) => {
    setDraft(null);
    setNotice("");
    if (!canEdit) return;
    const book = spendSnapshot().book;
    const trimmed = raw.trim();
    if (!trimmed) {
      if (mine) {
        const cleared = clearSpendLimit(scope, who, period, book.revision, { by: "person" });
        if (!cleared.written) setNotice(cleared.reason ?? "That change didn't stick. Try again.");
      }
      return;
    }
    const amount = parseDollars(trimmed);
    if (amount === "bad" || amount === null) {
      setNotice(BAD_AMOUNT);
      return;
    }
    const saved = saveSpendLimit(
      { scope, project: who, period, amountUsd: amount, warnAt: mine?.warnAt ?? 0.8 },
      book.revision,
      { by: "person" },
    );
    if (!saved.written) setNotice(saved.reason ?? "That change didn't stick. Try again.");
  };

  return (
    <div className="flex flex-col gap-1" data-spend-limit={revision} {...(indexed ? { "data-setting-id": "spend-limit" } : {})}>
      <p className="text-[12px] leading-4 text-content/60" data-spend-line>
        {text || UNSET}
      </p>
      {unreadable ? (
        <div className="flex items-center justify-between gap-2 text-[12px] text-content/70">
          <span>Saved spend limits could not be read. New builders wait until you replace them.</span>
          <button
            type="button"
            data-spend-replace
            onClick={() => setNotice(replaceUnreadableSpendStore() ? "" : "Those limits couldn't be replaced. Try again.")}
            className="rounded-lg border border-content/10 px-2 py-1 text-[12px] text-content"
          >
            Replace unreadable limits
          </button>
        </div>
      ) : null}
      <label className="flex items-center justify-between gap-2 text-[13px] text-content">
        {label}
        <span className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            aria-label={label}
            data-spend-amount
            value={field}
            placeholder="None"
            disabled={!canEdit || unreadable}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
            className="w-16 rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-right text-[13px] text-content outline-none focus:border-content/30"
          />
          <select
            aria-label="Spend limit period"
            data-spend-period
            value={period}
            onChange={(event) => {
              setDraft(null);
              setPeriod(event.target.value === "day" ? "day" : "month");
            }}
            className="rounded-lg border border-content/10 bg-content/5 px-1 py-1 text-[12px] text-content"
          >
            <option value="month">this month</option>
            <option value="day">today</option>
          </select>
        </span>
      </label>
      {notice ? (
        <p role="status" data-spend-notice className="text-[12px] leading-4 text-content/70">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
