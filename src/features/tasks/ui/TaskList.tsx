import type { Task, TaskStatusDef } from "../vendor/models";
import { listSections } from "../vendor/views/layoutGroups";
import type { GroupContext } from "../vendor/views/grouping";
import { buildTaskTree, flattenTree } from "../vendor/views/taskTree";
import type { DisplayOptions } from "../vendor/views/viewState";
import type { StoreTask } from "../model/mapTask";
import { PriorityOfTask, StatusOfTask, TaskFacts } from "./TaskControls";
import type { BoardItem } from "./TaskBoard";

export function TaskList({
  items,
  display,
  statuses,
  context,
  selected,
  onSelect,
  onOpen,
  onWrite,
}: {
  items: readonly BoardItem[];
  display: DisplayOptions;
  statuses: readonly TaskStatusDef[];
  context: GroupContext;
  selected: ReadonlySet<string>;
  onSelect: (id: string, on: boolean) => void;
  onOpen: (id: string) => void;
  onWrite: (task: StoreTask, fields: Record<string, unknown>) => void;
}) {
  const byId = new Map(items.map((item) => [item.orbit.id, item]));
  const sections = listSections(items.map((item) => item.orbit), display, context);
  return (
    <div className="mt-2 space-y-2">
      {sections.map((section) => {
        const own = section.group.tasks;
        const tree = buildTaskTree(own);
        const roots = own.filter((task) => !task.parentTaskId || !byId.has(task.parentTaskId));
        const rows: { task: Task; depth: number }[] =
          display.sub_issues === "flat"
            ? own.map((task) => ({ task, depth: 0 }))
            : display.sub_issues === "hidden"
              ? roots.map((task) => ({ task, depth: 0 }))
              : flattenTree(tree, roots, new Set()).map((row) => ({ task: row.task, depth: row.depth }));
        if (display.group_by !== "none" && rows.length === 0 && !display.show_empty_groups) return null;
        return (
          <section key={section.group.key} role="group" aria-label={section.group.label}>
            {display.group_by === "none" ? null : <h3 className="text-[12px] text-content/70">{section.group.label}</h3>}
            <ul>
              {rows.map((row) => {
                const item = byId.get(row.task.id);
                if (!item) return null;
                return (
                  <li key={row.task.id} className="flex items-center gap-1.5" style={{ paddingLeft: row.depth * 16 }}>
                    <input
                      type="checkbox"
                      aria-label={`Select #${item.store.number}`}
                      checked={selected.has(item.store.id)}
                      onChange={(event) => onSelect(item.store.id, event.target.checked)}
                    />
                    <button type="button" className="text-[12px] text-content/80" onClick={() => onOpen(item.store.id)}>
                      #{item.store.number} {item.store.title}
                    </button>
                    <StatusOfTask task={item.store} statuses={statuses} onStatus={(status) => onWrite(item.store, { status })} />
                    <PriorityOfTask task={item.store} onPriority={(priority) => onWrite(item.store, { priority })} />
                    <TaskFacts task={item.store} closed={item.orbit.subIssueClosedCount ?? 0} total={item.orbit.subIssueCount ?? 0} />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
