import { useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { Task, TaskStatusDef } from "../vendor/models";
import { boardGrid, planDrop, valuesOf } from "../vendor/views/layoutGroups";
import type { GroupContext } from "../vendor/views/grouping";
import type { DisplayOptions, GroupBy } from "../vendor/views/viewState";
import { keyBetween } from "../model/order";
import { hivraFields, isAgentTask, type StoreTask } from "../model/mapTask";
import { PriorityOfTask, StatusOfTask, TaskFacts } from "./TaskControls";

export type BoardItem = { store: StoreTask; orbit: Task };

type Dragged = { id: string; field: GroupBy; value: string | null };

function readDrag(raw: string): Dragged | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Dragged>;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.field !== "string") return null;
    return { id: parsed.id, field: parsed.field as GroupBy, value: typeof parsed.value === "string" ? parsed.value : null };
  } catch {
    return null;
  }
}

function reorderKey(column: readonly StoreTask[], movingId: string, beforeId: string | null): string | null {
  const rest = column.filter((task) => task.id !== movingId);
  const index = beforeId == null ? rest.length : rest.findIndex((task) => task.id === beforeId);
  const at = index < 0 ? rest.length : index;
  return keyBetween(at > 0 ? rest[at - 1]?.sortKey || null : null, at < rest.length ? rest[at]?.sortKey || null : null);
}

export function TaskBoard({
  items,
  display,
  statuses,
  context,
  onOpen,
  onWrite,
  onNote,
}: {
  items: readonly BoardItem[];
  display: DisplayOptions;
  statuses: readonly TaskStatusDef[];
  context: GroupContext;
  onOpen: (id: string) => void;
  onWrite: (task: StoreTask, fields: Record<string, unknown>) => void;
  onNote: (note: string) => void;
}) {
  const [over, setOver] = useState<{ column: string; beforeId: string | null } | null>(null);
  const overRef = useRef(over);
  function remember(next: { column: string; beforeId: string | null } | null) {
    overRef.current = next;
    setOver(next);
  }
  const byId = new Map(items.map((item) => [item.store.id, item]));
  const grid = boardGrid(items.map((item) => item.orbit), display, context);

  function drop(event: ReactDragEvent, columnKey: string, field: GroupBy, value: string | null, columnTasks: StoreTask[]) {
    event.preventDefault();
    const dragged = readDrag(event.dataTransfer.getData("text/plain"));
    const beforeId = overRef.current?.column === columnKey ? overRef.current.beforeId : null;
    remember(null);
    if (!dragged) return;
    const item = byId.get(dragged.id);
    if (!item || isAgentTask(item.store)) return;
    const sortKey = display.order_by === "manual" ? reorderKey(columnTasks, item.store.id, beforeId) : null;
    const plan = planDrop(item.orbit, valuesOf({ field: dragged.field, value: dragged.value }), valuesOf({ field, value }), context);
    if (plan.kind === "error") {
      onNote(plan.message);
      return;
    }
    if (plan.kind === "duplicate") return;
    const fields = plan.kind === "update" ? hivraFields(plan.patch) : {};
    if (sortKey) fields.sort_key = sortKey;
    if (Object.keys(fields).length === 0) return;
    onWrite(item.store, fields);
  }

  return (
    <div className="mt-2 flex gap-2 overflow-x-auto">
      {grid.columns.map((column) => {
        const columnItems = column.tasks.flatMap((task) => {
          const item = byId.get(task.id);
          return item ? [item] : [];
        });
        return (
          <section
            key={column.key}
            role="region"
            aria-label={column.label}
            className="w-56 shrink-0 rounded-md border border-stroke p-2"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overRef.current?.column !== column.key || overRef.current.beforeId !== null) remember({ column: column.key, beforeId: null });
            }}
            onDrop={(event) => drop(event, column.key, column.field, column.value, columnItems.map((item) => item.store))}
          >
            <h3 className="text-[12px] text-content/70">{column.label}</h3>
            {over?.column === column.key && over.beforeId == null ? <div className="my-1 h-6 rounded border border-dashed border-stroke" /> : null}
            <ul className="mt-1 space-y-1">
              {columnItems.map((item) => (
                <li
                  key={item.store.id}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    remember({ column: column.key, beforeId: item.store.id });
                  }}
                >
                  {over?.column === column.key && over.beforeId === item.store.id ? (
                    <div className="mb-1 h-6 rounded border border-dashed border-stroke" />
                  ) : null}
                  <div className="rounded-md border border-stroke px-2 py-1">
                    <button
                      type="button"
                      draggable={!isAgentTask(item.store)}
                      className="text-left text-[12px] text-content/80"
                      onDragStart={(event) => {
                        if (isAgentTask(item.store)) {
                          event.preventDefault();
                          return;
                        }
                        event.dataTransfer.setData(
                          "text/plain",
                          JSON.stringify({ id: item.store.id, field: column.field, value: column.value }),
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onOpen(item.store.id)}
                    >
                      #{item.store.number} {item.store.title}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <StatusOfTask task={item.store} statuses={statuses} onStatus={(status) => onWrite(item.store, { status })} />
                      <PriorityOfTask task={item.store} onPriority={(priority) => onWrite(item.store, { priority })} />
                      <TaskFacts
                        task={item.store}
                        closed={item.orbit.subIssueClosedCount ?? 0}
                        total={item.orbit.subIssueCount ?? 0}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
