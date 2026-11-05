import type { TaskStatusDef, TaskPriority } from "../vendor/models";
import { PRIORITY_LABEL, PRIORITY_ORDER } from "../vendor/taskMeta";
import { isAgentTask, type StoreTask } from "../model/mapTask";

const selectClass = "bg-transparent text-[12px] text-content";

export function StatusOfTask({
  task,
  statuses,
  onStatus,
}: {
  task: StoreTask;
  statuses: readonly TaskStatusDef[];
  onStatus: (status: string) => void;
}) {
  if (isAgentTask(task)) return <span className="text-[12px] text-content/70">{task.status}</span>;
  const names = statuses.filter((status) => status.projectId === task.projectId).map((status) => status.name);
  const options = names.length > 0 ? [...new Set(names)] : ["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"];
  return (
    <select
      aria-label={`Status of #${task.number}`}
      className={selectClass}
      value={options.includes(task.status) ? task.status : ""}
      onChange={(event) => onStatus(event.target.value)}
    >
      {options.includes(task.status) ? null : <option value="">{task.status}</option>}
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

export function PriorityOfTask({ task, onPriority }: { task: StoreTask; onPriority: (priority: string) => void }) {
  const value = (PRIORITY_ORDER as readonly string[]).includes(task.priority) ? task.priority : "none";
  return (
    <select
      aria-label={`Priority of #${task.number}`}
      className={selectClass}
      value={value}
      onChange={(event) => onPriority(event.target.value)}
    >
      {PRIORITY_ORDER.map((priority) => (
        <option key={priority} value={priority}>
          {PRIORITY_LABEL[priority as TaskPriority]}
        </option>
      ))}
    </select>
  );
}

export function TaskFacts({ task, closed, total }: { task: StoreTask; closed: number; total: number }) {
  return (
    <>
      {task.assignee ? <span className="text-[12px] text-content/70">{task.assignee}</span> : null}
      {task.labels.map((label) => (
        <span key={label} className="text-[12px] text-content/70">
          {label}
        </span>
      ))}
      {total > 0 ? <span className="text-[12px] text-content/70">{`${closed}/${total}`}</span> : null}
      {task.cli ? <span className="max-w-24 truncate text-[12px] text-content/70">{task.cli}</span> : null}
    </>
  );
}
