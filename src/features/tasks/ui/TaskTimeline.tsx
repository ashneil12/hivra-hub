import type { Task, TaskStatusDef } from "../vendor/models";
import { groupTasks, type GroupContext } from "../vendor/views/grouping";
import { buildTimelineRows, computeRange, xOf } from "../vendor/views/timelineLib";
import type { DisplayOptions } from "../vendor/views/viewState";

const DAY = 16;

export function TaskTimeline({
  tasks,
  display,
  statuses,
  context,
  onOpen,
}: {
  tasks: readonly Task[];
  display: DisplayOptions;
  statuses: readonly TaskStatusDef[];
  context: GroupContext;
  onOpen: (id: string) => void;
}) {
  const field = display.group_by === "none" ? "status" : display.group_by;
  const groups = groupTasks([...tasks], field, { ...context, showEmpty: false });
  const rows = buildTimelineRows({ tasks: [...tasks], groups, statuses: [...statuses], overrides: {} });
  const range = computeRange(
    rows.flatMap((row) => (row.kind === "task" && row.span ? [row.span.start, row.span.end] : [])),
    new Date(),
  );
  return (
    <div className="mt-2 overflow-x-auto" aria-label="Timeline">
      <div style={{ minWidth: range.days * DAY }}>
        {rows.map((row) => {
          if (row.kind === "group")
            return (
              <h3 key={row.key} className="mt-2 text-[12px] text-content/70">
                {row.group.label}
              </h3>
            );
          if (row.kind === "undated") return null;
          const span = row.span;
          const left = span ? xOf(range, span.start, DAY) : 0;
          const width = span ? Math.max(DAY, xOf(range, span.end, DAY) - left + DAY) : DAY;
          return (
            <div key={row.key} className="relative h-7">
              <button type="button" className="relative z-10 text-[12px] text-content/80" onClick={() => onOpen(row.task.id)}>
                #{row.task.number} {row.task.title}
              </button>
              {span ? (
                <span
                  data-timeline-bar={row.task.id}
                  className="absolute top-1 h-4 rounded bg-content/20"
                  style={{ left, width }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
