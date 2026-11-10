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
import {
  enableWeeklyRetro,
  loadWeeklyRetro,
  markAsked,
  saveWeeklyRetro,
  stageRetro,
  weeklyRetroDue,
  type RetroResult,
  type WeeklyRetro,
} from "../model/retro";

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
  const [loaded, setLoaded] = useState(seeded);
  const [problem, setProblem] = useState<string | null>(null);
  const [routine, setRoutine] = useState<WeeklyRetro>(() => loadWeeklyRetro());
  const [report, setReport] = useState<RetroResult | null>(null);
  const [retroProblem, setRetroProblem] = useState<string | null>(null);
  const generation = useRef(0);
  const retroGeneration = useRef(0);
  const askedWeekly = useRef(false);

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
        setLoaded(true);
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

  async function weekLines(mine: number): Promise<WorkLogLine[] | null> {
    if (seeded) return lines;
    const query: { from: string; to: string; project?: string } = { from: shiftDay(today, -6), to: today };
    const named = project.trim();
    if (named) query.project = named;
    try {
      const rows = readLines(await invoke("work_log_read", query));
      if (mine !== retroGeneration.current) return null;
      return rows;
    } catch {
      // A timeout is not an empty week. Do not report that nothing shipped.
      if (mine !== retroGeneration.current) return null;
      setRetroProblem("The work log could not be read. Try again.");
      return null;
    }
  }

  function showRetro(rows: WorkLogLine[]) {
    const named = project.trim();
    const scoped = named ? rows.filter((line) => line.project === named) : rows;
    setRetroProblem(null);
    setReport(stageRetro(scoped, today));
  }

  async function runRetro() {
    const mine = ++retroGeneration.current;
    const rows = await weekLines(mine);
    if (rows === null || mine !== retroGeneration.current) return;
    showRetro(rows);
  }

  function toggleWeekly() {
    const next = routine.enabled
      ? { ...routine, enabled: false }
      : enableWeeklyRetro(new Date().toISOString());
    setRoutine(next);
    saveWeeklyRetro(next);
  }

  useEffect(() => {
    if (askedWeekly.current || !weeklyRetroDue(routine, Date.now())) return;
    if (!seeded && !loaded) return;
    let cancelled = false;
    const mine = ++retroGeneration.current;
    void weekLines(mine).then((rows) => {
      if (cancelled || rows === null || mine !== retroGeneration.current) return;
      askedWeekly.current = true;
      showRetro(rows);
      const marked = markAsked(routine, new Date().toISOString());
      setRoutine(marked);
      saveWeeklyRetro(marked);
    });
    return () => {
      cancelled = true;
    };
  }, [routine, seeded, loaded, lines, today, project]);

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
          <button type="button" className="rounded-md px-2 py-1 text-[13px] text-content" onClick={() => void runRetro()}>
            Run a retro
          </button>
          <button
            type="button"
            aria-pressed={routine.enabled}
            className="rounded-md px-2 py-1 text-[13px] text-content"
            onClick={toggleWeekly}
          >
            Weekly retro
          </button>
        </div>
      </div>
      {retroProblem ? <p className="px-3 text-[13px] text-content/60">{retroProblem}</p> : null}
      {report ? (
        <div data-retro className="flex flex-col gap-2 px-3 text-[13px] text-content">
          <p className="whitespace-pre-wrap">{report.report}</p>
          {report.ask ? <p className="whitespace-pre-wrap text-content/80">{report.ask}</p> : null}
          {report.pending.length === 0 ? (
            <p>No edits proposed.</p>
          ) : (
            <ul aria-label="Pending edits">
              {report.pending.map((edit) => (
                <li key={edit.id}>{edit.text}</li>
              ))}
            </ul>
          )}
          <p>Nothing was changed.</p>
        </div>
      ) : null}
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
