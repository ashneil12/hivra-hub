import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import {
  applyUsageFilter,
  defaultUsageFilter,
  usageFilterChoices,
  usageFilterFrom,
  type UsageFilter,
  type UsageFilterChoice,
} from "../model/filter";
import {
  buildUsageHistory,
  costNote,
  dayLabel,
  formatTokenCount,
  formatUsd,
  toCsv,
  type UsageGroup,
  type UsageHistory,
  type UsageSession,
  type UsageTotals,
} from "../model/history";
import { loadUsageSessions } from "../model/load";

type Props = {
  /** Saved chats to read. When set, the page does not ask the app. */
  sessions?: readonly UsageSession[];
  /** Epoch ms the window ends at. Tests pass a fixed clock. */
  now?: number;
};

/**
 * Settings, Usage (WP-108). Today, the last 7 days and the last 30 days, a bar per day, and tables by project,
 * engine and model. Read only: copying the CSV stays on this computer.
 */
export function UsagePage({ sessions, now }: Props) {
  const seeded = sessions !== undefined;
  const [liveClock] = useState(() => Date.now());
  const at = now ?? liveClock;
  const [liveSessions, setLiveSessions] = useState<readonly UsageSession[] | null>(null);
  const [filter, setFilter] = useState<UsageFilter>(() => defaultUsageFilter());
  const [problem, setProblem] = useState(false);
  const [loading, setLoading] = useState(!seeded);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const generation = useRef(0);

  useEffect(() => {
    if (seeded) return;
    const mine = ++generation.current;
    let cancelled = false;
    setLoading(true);
    void loadUsageSessions(at)
      .then((next) => {
        if (cancelled || mine !== generation.current) return;
        setLiveSessions(next);
        setProblem(false);
        setLoading(false);
      })
      .catch(() => {
        // A timeout is not an empty history. Keep the numbers already on screen.
        if (cancelled || mine !== generation.current) return;
        setProblem(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seeded, at, attempt]);

  const source = seeded ? (sessions ?? []) : liveSessions;
  const filtered = useMemo(
    () => (source == null ? null : applyUsageFilter(source, filter)),
    [source, filter],
  );
  const history = useMemo(
    () => (filtered ? buildUsageHistory(filtered, { now: at }) : null),
    [filtered, at],
  );
  const choices = useMemo(
    () => usageFilterChoices(source ?? [], filter.provider),
    [source, filter.provider],
  );
  const hiddenByFilter =
    history != null &&
    history.last30.turns === 0 &&
    source != null &&
    buildUsageHistory(source, { now: at }).last30.turns > 0;

  function onProvider(provider: string) {
    setFilter((current) => {
      const next = usageFilterFrom({ provider, model: current.model });
      const models = usageFilterChoices(source ?? [], next.provider).models;
      if (next.model && !models.some((item) => item.id === next.model)) {
        return { ...next, model: "" };
      }
      return next;
    });
  }

  async function onCopy() {
    if (!history) return;
    try {
      await copyText(toCsv(history));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-8" data-usage>
      {problem ? (
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-content/70">
          <p>{history ? "Could not load the latest usage." : "Could not load usage."}</p>
          <SecondaryButton onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </SecondaryButton>
        </div>
      ) : null}
      {loading && !history ? <p className="text-[13px] text-content/60">Loading usage.</p> : null}
      {history ? (
        <UsageBody
          history={history}
          hiddenByFilter={hiddenByFilter}
          filter={filter}
          choices={choices}
          onProvider={onProvider}
          onModel={(model) => setFilter((current) => usageFilterFrom({ ...current, model }))}
          copyLabel={
            copyState === "copied" ? "Copied" : copyState === "failed" ? "Could not copy" : "Copy as CSV"
          }
          onCopy={() => void onCopy()}
        />
      ) : null}
    </div>
  );
}

function UsageBody({
  history,
  hiddenByFilter,
  filter,
  choices,
  onProvider,
  onModel,
  copyLabel,
  onCopy,
}: {
  history: UsageHistory;
  hiddenByFilter: boolean;
  filter: UsageFilter;
  choices: { providers: UsageFilterChoice[]; models: UsageFilterChoice[] };
  onProvider: (provider: string) => void;
  onModel: (model: string) => void;
  copyLabel: string;
  onCopy: () => void;
}) {
  const empty = history.last30.turns === 0;
  return (
    <>
      <UsageFilters filter={filter} choices={choices} onProvider={onProvider} onModel={onModel} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-content/60">
          {hiddenByFilter
            ? "No turns for this filter."
            : empty
              ? "No turns in the last 30 days."
              : "Tokens and cost for the last 30 days."}
        </p>
        <SecondaryButton onClick={onCopy}>{copyLabel}</SecondaryButton>
      </div>
      {empty ? null : (
        <p className="text-xs text-content/60">
          Estimated cost is what the same use would cost at API prices. If you use a Claude subscription you pay a flat fee, so
          this is not your bill.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Summary title="Today" totals={history.today} />
        <Summary title="Last 7 days" totals={history.last7} />
        <Summary title="Last 30 days" totals={history.last30} />
      </div>
      <DayBars history={history} />
      <TotalsTable caption="By project" rows={history.byProject} />
      <TotalsTable caption="By engine" rows={history.byEngine} />
      <TotalsTable caption="By model" rows={history.byModel} />
    </>
  );
}

function UsageFilters({
  filter,
  choices,
  onProvider,
  onModel,
}: {
  filter: UsageFilter;
  choices: { providers: UsageFilterChoice[]; models: UsageFilterChoice[] };
  onProvider: (provider: string) => void;
  onModel: (model: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-[13px] text-content/70" data-usage-filters>
      <label className="flex items-center gap-2">
        Provider
        <select
          aria-label="Provider"
          value={filter.provider}
          onChange={(event) => onProvider(event.target.value)}
          className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
        >
          <option value="">All</option>
          {choices.providers.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        Model
        <select
          aria-label="Model"
          value={filter.model}
          onChange={(event) => onModel(event.target.value)}
          className="rounded-md border border-stroke bg-transparent px-2 py-1 text-content"
        >
          <option value="">All</option>
          {choices.models.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Summary({ title, totals }: { title: string; totals: UsageTotals }) {
  const tokens = totals.inputTokens + totals.outputTokens;
  return (
    <section aria-label={title} className="rounded-md border border-stroke px-3 py-2">
      <h3 className="text-xs font-medium text-content/50">{title}</h3>
      <p className="mt-1 text-sm text-content">{formatTokenCount(tokens)} tokens</p>
      <p className="text-xs text-content/60">
        {formatTokenCount(totals.inputTokens)} in, {formatTokenCount(totals.outputTokens)} out
        {totals.turns > 0 ? `, ${formatTokenCount(totals.turns)} ${totals.turns === 1 ? "turn" : "turns"}` : ""}
      </p>
      {totals.cacheReadTokens > 0 || totals.cacheWriteTokens > 0 ? (
        <p className="text-xs text-content/60">
          {formatTokenCount(totals.cacheReadTokens)} cache read, {formatTokenCount(totals.cacheWriteTokens)} cache write
        </p>
      ) : null}
      <p className="mt-1 text-sm text-content">{costLine(totals)}</p>
      {estimateLine(totals) ? <p className="text-xs text-content/50">{estimateLine(totals)}</p> : null}
    </section>
  );
}

function costLine(totals: UsageTotals): string {
  if (totals.turns === 0) return "No turns yet";
  if (totals.costTurns === 0) return costNote(totals);
  if (totals.costTurns < totals.turns) return `${formatUsd(totals.costUsd)}. ${costNote(totals)}`;
  return formatUsd(totals.costUsd);
}

/**
 * WP-253: turns with no reported price, at API list prices, and what cache reads saved. Shown muted and apart from the
 * reported cost, so an estimate never reads as one.
 */
export function estimateLine(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.estimatedTurns > 0) {
    const turns = `${formatTokenCount(totals.estimatedTurns)} ${totals.estimatedTurns === 1 ? "turn" : "turns"}`;
    parts.push(`About ${formatUsd(totals.estimatedUsd)} at list prices for ${turns} with no reported cost`);
  }
  if (totals.cacheSavedUsd >= 0.01) parts.push(`cache saved about ${formatUsd(totals.cacheSavedUsd)}`);
  if (parts.length === 0) return "";
  // The page note already says these figures are not the bill; it is said once (UsagePage.test.ts).
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

function DayBars({ history }: { history: UsageHistory }) {
  const weights = history.days.map((day) => day.totals.inputTokens + day.totals.outputTokens);
  const max = weights.reduce((peak, weight) => (weight > peak ? weight : peak), 0);
  const first = history.days[0];
  const last = history.days[history.days.length - 1];
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium text-content">By day</h3>
      <ul aria-label="Tokens by day" className="flex h-24 items-end gap-px">
        {history.days.map((day, index) => {
          const weight = weights[index] ?? 0;
          const label = dayLabel(day.day) || "Unknown day";
          const text = weight > 0 ? `${label}, ${formatTokenCount(weight)} tokens` : `${label}, no tokens`;
          const height = max === 0 || weight === 0 ? 0 : Math.max((weight / max) * 100, 8);
          return (
            <li
              key={`${day.day}-${index}`}
              title={text}
              aria-label={text}
              data-usage-day={day.day}
              className="flex h-full min-w-0 flex-1 items-end"
            >
              <div
                className={`w-full rounded-sm ${weight > 0 ? "bg-content/80" : "bg-content/15"}`}
                style={{ height: weight > 0 ? `${height}%` : "2px" }}
              />
            </li>
          );
        })}
      </ul>
      <div className="flex justify-between text-xs text-content/45">
        <span>{first ? dayLabel(first.day) : ""}</span>
        <span>{last ? dayLabel(last.day) : ""}</span>
      </div>
    </div>
  );
}

function costCell(totals: UsageTotals): string {
  if (totals.costTurns === 0 && totals.estimatedTurns > 0) return `About ${formatUsd(totals.estimatedUsd)} at list prices`;
  if (totals.costTurns === 0) return "Cost not reported by this engine";
  if (totals.costTurns < totals.turns) return `${formatUsd(totals.costUsd)} (${costNote(totals)})`;
  return formatUsd(totals.costUsd);
}

function TotalsTable({ caption, rows }: { caption: string; rows: UsageGroup[] }) {
  if (rows.length === 0) return null;
  const showCache = rows.some(
    (row) => row.totals.cacheReadTokens > 0 || row.totals.cacheWriteTokens > 0,
  );
  return (
    <table className="w-full border-collapse text-left text-sm">
      <caption className="pb-2 text-left text-sm font-medium text-content">{caption}</caption>
      <thead>
        <tr className="text-xs text-content/50">
          <th scope="col" className="py-1 pr-3 font-medium">Name</th>
          <th scope="col" className="py-1 pr-3 text-right font-medium">Turns</th>
          <th scope="col" className="py-1 pr-3 text-right font-medium">Input tokens</th>
          <th scope="col" className="py-1 pr-3 text-right font-medium">Output tokens</th>
          {showCache ? (
            <th scope="col" className="py-1 pr-3 text-right font-medium">Cache read</th>
          ) : null}
          {showCache ? (
            <th scope="col" className="py-1 pr-3 text-right font-medium">Cache write</th>
          ) : null}
          <th scope="col" className="py-1 text-right font-medium">Estimated cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-stroke">
            <th scope="row" className="py-1.5 pr-3 font-normal text-content">{row.label}</th>
            <td className="py-1.5 pr-3 text-right tabular-nums text-content/80">{formatTokenCount(row.totals.turns)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-content/80">{formatTokenCount(row.totals.inputTokens)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums text-content/80">{formatTokenCount(row.totals.outputTokens)}</td>
            {showCache ? (
              <td className="py-1.5 pr-3 text-right tabular-nums text-content/80">{formatTokenCount(row.totals.cacheReadTokens)}</td>
            ) : null}
            {showCache ? (
              <td className="py-1.5 pr-3 text-right tabular-nums text-content/80">{formatTokenCount(row.totals.cacheWriteTokens)}</td>
            ) : null}
            <td className="py-1.5 text-right text-content/80">{costCell(row.totals)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
