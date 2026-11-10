import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  groupLines,
  localDay,
  readLines,
  shiftDay,
  todayAnswer,
  type WorkLogLine,
} from "../model/workLog";

type Span = "today" | "week";

type Props = {
  /** A seeded list. When given, the panel does not ask the app. */
  lines?: WorkLogLine[];
  /** The local day the panel calls today. Tests pass one; the app uses the clock. */
  today?: string;
};

function inSpan(line: WorkLogLine, span: Span, today: string): boolean {
  if (span === "today") return line.day === today;
  const from = shiftDay(today, -6);
  return line.day >= from && line.day <= today;
}

/**
 * Settings → Work log (WP-157). One project or every project, grouped by day
 * and kind. "What got done today?" is the outcome lines for today.
 */
export function WorkLogPanel({ lines, today: todayProp }: Props) {
  const seeded = lines !== undefined;
  const today = todayProp && todayProp.trim() ? todayProp : localDay(new Date());
  const [project, setProject] = useState("");
  const [span, setSpan] = useState<Span>("week");
  const [live, setLive] = useState<WorkLogLine[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (seeded) return;
    const mine = ++generation.current;
    let cancelled = false;
    const query: { day?: string; from?: string; to?: string; project?: string } =
      span === "today" ? { day: today } : { from: shiftDay(today, -6), to: today };
    const named = project.trim();
    if (named) query.project = named;
    void invoke("work_log_read", query)
      .then((rows) => {
        if (cancelled || mine !== generation.current) return;
        setLive(readLines(rows));
        setProblem(null);
      })
      .catch(() => {
        // A timeout is not an empty log. Leave the rows already on screen.
        if (cancelled || mine !== generation.current) return;
        setProblem("The work log could not be read. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [seeded, project, span, today]);

  const source = (seeded ? lines : live).filter((line) => inSpan(line, span, today));
  const grouped = groupLines(source, project);
  const answer = todayAnswer(
    source.filter((line) => !project.trim() || line.project === project.trim()),
    today,
  );
  const filtering = project.trim() !== "";

  return (
    <div className="flex flex-col gap-4" data-work-log>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-content/60">
          Project
          <input
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="rounded-md bg-content/5 px-2 py-1 text-[13px] text-content"
          />
        </label>
        <div className="flex gap-1">
          <SpanButton current={span} value="today" onPick={setSpan} label="Today" />
          <SpanButton current={span} value="week" onPick={setSpan} label="This week" />
        </div>
      </div>
      <p className="px-3 text-[13px] text-content" data-today-answer>
        {answer}
      </p>
      {grouped.length === 0 ? (
        <p className="px-3 text-[13px] text-content/60">
          {problem && !seeded ? problem : filtering ? "Nothing matches." : "Nothing has been written yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {problem && !seeded ? (
            <p className="px-3 text-[13px] text-content/60">{problem}</p>
          ) : null}
          {grouped.map((day) => (
            <section key={day.day} data-day={day.day} className="flex flex-col gap-2">
              <h3 className="px-3 text-[13px] text-content">{day.day === today ? `Today, ${day.day}` : day.day}</h3>
              {day.kinds.map((kind) => (
                <div key={kind.kind} data-kind={kind.kind}>
                  <h4 className="px-3 text-xs text-content/60">{kind.label}</h4>
                  <ul aria-label={kind.label} className="flex flex-col">
                    {kind.lines.map((row, index) => (
                      <li key={`${row.day}-${row.kind}-${index}`} className="px-3 py-1.5 text-[13px] text-content">
                        {row.line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SpanButton({
  current,
  value,
  label,
  onPick,
}: {
  current: Span;
  value: Span;
  label: string;
  onPick: (value: Span) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={current === value}
      className="rounded-md px-2 py-1 text-[13px] text-content"
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
}
