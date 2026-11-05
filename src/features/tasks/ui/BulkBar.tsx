import type { TaskPriority, TaskStatusDef } from "../vendor/models";
import { PRIORITY_LABEL, PRIORITY_ORDER } from "../vendor/taskMeta";

const field = "bg-transparent text-[12px] text-content";

export function BulkBar({
  count,
  statuses,
  onStatus,
  onPriority,
  onAssignee,
  onLabels,
}: {
  count: number;
  statuses: readonly TaskStatusDef[];
  onStatus: (status: string) => void;
  onPriority: (priority: string) => void;
  onAssignee: (assignee: string) => void;
  onLabels: (labels: string[]) => void;
}) {
  if (count === 0) return null;
  const names = [...new Set(statuses.map((status) => status.name))];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Bulk edit">
      <span className="text-[12px] text-content/70">{count === 1 ? "1 task" : `${count} tasks`}</span>
      <select aria-label="Bulk status" className={field} value="" onChange={(event) => event.target.value && onStatus(event.target.value)}>
        <option value="">Status</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select aria-label="Bulk priority" className={field} value="" onChange={(event) => event.target.value && onPriority(event.target.value)}>
        <option value="">Priority</option>
        {PRIORITY_ORDER.map((priority) => (
          <option key={priority} value={priority}>
            {PRIORITY_LABEL[priority as TaskPriority]}
          </option>
        ))}
      </select>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAssignee(String(data.get("assignee") ?? "").trim());
          event.currentTarget.reset();
        }}
      >
        <input name="assignee" aria-label="Bulk assignee" placeholder="Assignee" className={`w-28 rounded-md border border-stroke px-2 py-1 ${field}`} />
        <button type="submit" className="text-[12px] text-content/70">
          Assign selected
        </button>
      </form>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onLabels(
            String(data.get("labels") ?? "")
              .split(",")
              .map((label) => label.trim())
              .filter((label) => label !== ""),
          );
          event.currentTarget.reset();
        }}
      >
        <input name="labels" aria-label="Bulk labels" placeholder="Labels" className={`w-28 rounded-md border border-stroke px-2 py-1 ${field}`} />
        <button type="submit" className="text-[12px] text-content/70">
          Set labels
        </button>
      </form>
    </div>
  );
}
