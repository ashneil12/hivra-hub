import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ACTIVITY_CHANGED,
  whenLabel,
  type ActivityEntry,
} from "../../activity/model/activity";
import type { Automation } from "../model/automations";
import { automationFilterLabel } from "../model/shownText";
import {
  collectRunPages,
  sessionIdFromLink,
  visibleRuns,
  type RunResult,
} from "../model/runFeed";

/**
 * WP-180a: every run, newest first, from the activity log. A failed refresh
 * leaves the rows already on screen. A line with a chat opens that chat.
 */
export function AutomationRuns({
  automations,
  onOpenSession,
}: {
  automations: readonly Automation[];
  onOpenSession: (sessionId: string) => void | Promise<void>;
}) {
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [automationId, setAutomationId] = useState("");
  const [result, setResult] = useState<RunResult | "">("");
  const [problem, setProblem] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await collectRunPages(
        (kind, before) =>
          invoke("activity_list", { query: { kind, limit: 100, before } }),
        () => mine !== generation.current,
      );
      if (mine !== generation.current) return;
      setRows(next);
      setProblem(null);
    } catch {
      // A timeout is not an empty list. Leave the rows already on screen.
      if (mine !== generation.current) return;
      setProblem("Couldn't refresh runs.");
    }
  }, []);

  useEffect(() => {
    void load();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(ACTIVITY_CHANGED, () => {
      void load();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      generation.current += 1;
    };
  }, [load]);

  const shown = visibleRuns(rows, { automationId, result });
  const filtering = automationId !== "" || result !== "";
  const names = [...automations]
    .filter((automation) => automation.id.trim() !== "")
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-automation-runs>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke px-4 py-2">
        <label className="flex items-center gap-2 text-[12px] text-content/70">
          Automation
          <select
            aria-label="Automation"
            value={automationId}
            onChange={(event) => setAutomationId(event.target.value)}
            className="h-7 rounded-md border border-stroke bg-transparent px-2 text-[12px] text-content"
          >
            <option value="">All automations</option>
            {names.map((automation) => (
              <option key={automation.id} value={automation.id}>
                {automationFilterLabel(automation.name)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-content/70">
          Result
          <select
            aria-label="Result"
            value={result}
            onChange={(event) => setResult(event.target.value as RunResult | "")}
            className="h-7 rounded-md border border-stroke bg-transparent px-2 text-[12px] text-content"
          >
            <option value="">All results</option>
            <option value="started">Started</option>
            <option value="finished">Finished</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      {problem && rows.length > 0 ? (
        <p className="px-4 pt-3 text-[12px] text-content/55">{problem}</p>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-4 py-8 text-[13px] text-content/60">
          {rows.length === 0 && problem
            ? "Couldn't load runs."
            : filtering
              ? "Nothing matches."
              : "No runs yet."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {shown.map((entry) => (
            <li key={entry.id} className="border-b border-stroke/70 last:border-b-0">
              <RunLine entry={entry} onOpenSession={onOpenSession} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunLine({
  entry,
  onOpenSession,
}: {
  entry: ActivityEntry;
  onOpenSession: (sessionId: string) => void | Promise<void>;
}) {
  const sessionId = sessionIdFromLink(entry.link);
  const when = whenLabel(entry.at);
  const body = (
    <>
      <span className="min-w-0 flex-1 text-left text-[13px] text-content">
        {entry.summary}
      </span>
      {when ? (
        <span className="shrink-0 text-[11px] text-content/45">{when}</span>
      ) : null}
    </>
  );
  if (!sessionId) {
    return <div className="flex items-baseline gap-3 px-2 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => void onOpenSession(sessionId)}
      className="flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-content/5"
    >
      {body}
    </button>
  );
}
