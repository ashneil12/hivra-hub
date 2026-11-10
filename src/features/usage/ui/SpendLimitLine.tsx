// WP-176. One line for a measured-cost limit, on the project Workers dialog and Settings > Crew.
// Nothing here stops a builder that is already running. Blank means no limit.

import { useState, useSyncExternalStore } from "react";
import {
  clearSpendLimit,
  saveSpendLimit,
  spendFor,
  spendLine,
  spendSnapshot,
  subscribeSpend,
} from "../model/spendGate";
import type { SpendPeriod } from "../model/spend";

const UNSET = "No spend limit is set.";

function amountText(value: number): string {
  return String(value);
}

/** The project limit for this period, or the app limit when this project has none. */
export function SpendLimitLine({
  project,
  harness = "claude",
  indexed = false,
}: {
  project: string;
  harness?: string;
  /** Settings search lands on this line. The project dialog leaves it off. */
  indexed?: boolean;
}) {
  const revision = useSyncExternalStore(subscribeSpend, () => spendSnapshot().book.revision, () => 0);
  const [period, setPeriod] = useState<SpendPeriod>("month");
  const [draft, setDraft] = useState<string | null>(null);
  const rows = spendFor(project);
  const mine = rows.find((row) => row.scope === "project" && row.period === period);
  const app = rows.find((row) => row.scope === "app");
  const shown = mine ? "project" : app ? "app" : "project";
  const text = rows.length ? spendLine(project, harness, shown === "app" && !mine ? "app" : "project") : UNSET;
  const shownText = text || UNSET;
  const field = draft ?? (mine ? amountText(mine.amountUsd) : "");

  const commit = (raw: string) => {
    setDraft(null);
    const book = spendSnapshot().book;
    const trimmed = raw.trim();
    if (!project.trim()) return;
    if (!trimmed) {
      if (mine) clearSpendLimit("project", project, period, book.revision);
      return;
    }
    const amount = Number(trimmed);
    if (!Number.isFinite(amount) || amount <= 0) return;
    saveSpendLimit(
      { scope: "project", project, period, amountUsd: amount, warnAt: mine?.warnAt ?? 0.8 },
      spendSnapshot().book.revision,
    );
  };

  return (
    <div className="flex flex-col gap-1" data-spend-limit={revision} {...(indexed ? { "data-setting-id": "spend-limit" } : {})}>
      <p className="text-[12px] leading-4 text-content/60" data-spend-line>
        {shownText}
      </p>
      <label className="flex items-center justify-between gap-2 text-[13px] text-content">
        Measured cost limit
        <span className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            aria-label="Measured cost limit"
            data-spend-amount
            value={field}
            placeholder="None"
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
    </div>
  );
}
