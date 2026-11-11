// The one Agents board. A row opens its chat read-only: no composer, one Stop that asks once.

import { useMemo, useState } from "react";
import { boardChipCounts } from "../model/counts";
import { loadOpenMap, rowOpen, saveOpenMap, type OpenMap } from "../model/expand";
import { filterBoard, settledToday, type BoardFilter, type BoardStateFilter } from "../model/filter";
import { cancelStop, confirmStop, requestStop, stopTarget, type StopPhase } from "../model/stop";
import { flattenBoard, type BoardNode, type BoardState } from "../model/tree";

const CHIP: Record<BoardState, { label: string; className: string }> = {
  "needs-you": { label: "Needs you", className: "bg-[#e5484d]/15 text-[#e5484d]" },
  working: { label: "Working", className: "bg-[#3b82f6]/15 text-[#60a5fa]" },
  done: { label: "Done", className: "bg-emerald-400/15 text-emerald-300" },
  idle: { label: "Idle", className: "bg-white/10 text-white/45" },
};

export function AgentsBoard({
  tree,
  projects,
  now,
  lines,
  onStop,
  initialOpen,
}: {
  tree: BoardNode;
  projects: readonly { id: string; name: string }[];
  now: number;
  lines: Record<string, readonly string[]>;
  onStop: (id: string) => void;
  initialOpen?: OpenMap;
}) {
  const [filter, setFilter] = useState<BoardFilter>({ projectId: null, state: null });
  const [open, setOpen] = useState<OpenMap>(() => ({ ...initialOpen, ...loadOpenMap() }));
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<StopPhase>("closed");
  const shown = useMemo(() => filterBoard(tree, filter, now), [tree, filter, now]);
  const counts = useMemo(() => boardChipCounts(tree, filter.projectId, now), [tree, filter.projectId, now]);
  const ids = useMemo(() => flattenBoard(shown).map((node) => node.id), [shown]);
  const current = selected ? flattenBoard(shown).find((node) => node.id === selected) ?? null : null;
  const asking = phase === "asking" && current != null;

  function pick(id: string) {
    setSelected(id);
    setPhase("closed");
  }

  function toggle(node: BoardNode) {
    setOpen((prev) => {
      const next = { ...prev, [node.id]: !rowOpen(node.id, node.role, prev) };
      saveOpenMap(next);
      return next;
    });
  }

  function askStop() {
    const next = requestStop(phase);
    setPhase(next.phase);
  }

  function confirm() {
    const next = confirmStop(phase);
    const target = stopTarget(current?.id ?? null, ids);
    if (next.stop && target) onStop(target);
    setPhase(target ? next.phase : "closed");
  }

  return (
    <div data-agents-board className="flex h-full min-h-0 flex-col bg-[#141416] text-[#f2f2f2]">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        <h1 className="mr-2 text-[15px] font-medium">Agents</h1>
        <label className="text-[12px] text-white/50">
          <span className="sr-only">Project</span>
          <select
            aria-label="Project"
            className="rounded-md border border-white/10 bg-[#1b1b1d] px-2 py-1 text-[13px] text-[#f2f2f2]"
            value={filter.projectId ?? ""}
            onChange={(event) => setFilter({ ...filter, projectId: event.target.value || null })}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <FilterChip label="Needs you" count={counts.needsYou} pressed={filter.state === "needs-you"} onClick={() => setState(setFilter, "needs-you")} />
        <FilterChip label="Working" count={counts.working} pressed={filter.state === "working"} onClick={() => setState(setFilter, "working")} />
        <FilterChip label="Done today" count={counts.doneToday} pressed={filter.state === "done-today"} onClick={() => setState(setFilter, "done-today")} />
      </header>
      <div className="flex min-h-0 flex-1">
        <div role="tree" aria-label="Agents" className="min-w-0 flex-1 overflow-auto py-2">
          <Rows node={shown} depth={0} now={now} open={open} selected={selected} onPick={pick} onToggle={toggle} />
        </div>
        {current ? (
          <aside data-readonly-chat className="flex w-[380px] shrink-0 flex-col border-l border-white/10">
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-[14px] font-medium">{current.name}</p>
              <p className="mt-1 text-[12px] text-white/50">{CHIP[current.state].label}</p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-3 text-[13px] leading-5 text-white/80">
              {(lines[current.id] ?? []).length ? (
                (lines[current.id] ?? []).map((line, index) => <p key={index}>{line}</p>)
              ) : (
                <p className="text-white/45">No messages in this chat yet.</p>
              )}
            </div>
            <div className="border-t border-white/10 px-4 py-3">
              {asking ? (
                <div role="dialog" aria-label="Stop this chat" data-stop-ask className="flex items-center gap-2">
                  <p className="mr-auto text-[13px]">Stop {current.name}?</p>
                  <button type="button" className="rounded-md bg-[#e5484d] px-3 py-1.5 text-[13px] text-white" onClick={confirm}>
                    Stop
                  </button>
                  <button type="button" className="rounded-md px-3 py-1.5 text-[13px] text-white/70" onClick={() => setPhase(cancelStop(phase))}>
                    Cancel
                  </button>
                </div>
              ) : current.canStop && phase !== "stopped" ? (
                <button type="button" className="rounded-md border border-white/15 px-3 py-1.5 text-[13px]" onClick={askStop}>
                  Stop
                </button>
              ) : (
                <p className="text-[12px] text-white/40">Read only</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function setState(
  setFilter: (value: BoardFilter | ((prev: BoardFilter) => BoardFilter)) => void,
  state: BoardStateFilter,
) {
  setFilter((prev) => ({ ...prev, state: prev.state === state ? null : state }));
}

function FilterChip({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3b82f6] ${
        pressed ? "border-white/70 bg-white/20 text-white" : "border-white/20 text-white/75 hover:bg-white/5"
      }`}
    >
      {label}
      <span data-count aria-hidden className="ml-1.5 tabular-nums text-white/45">
        {count}
      </span>
    </button>
  );
}

function Rows({
  node,
  depth,
  now,
  open,
  selected,
  onPick,
  onToggle,
}: {
  node: BoardNode;
  depth: number;
  now: number;
  open: OpenMap;
  selected: string | null;
  onPick: (id: string) => void;
  onToggle: (node: BoardNode) => void;
}) {
  const expanded = rowOpen(node.id, node.role, open);
  const showKids = expanded && node.children.length > 0;
  const doneToday = node.state === "done" && settledToday(node.settledAt, now);
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.children.length ? expanded : undefined}
        data-node={node.id}
        data-role={node.role}
        data-state={node.state}
        data-done-today={doneToday ? "true" : "false"}
        onClick={() => onPick(node.id)}
        className={`grid cursor-pointer items-center gap-x-3 px-3 py-2 text-[13px] ${selected === node.id ? "bg-white/8" : "hover:bg-white/5"}`}
        style={{ gridTemplateColumns: "16rem 5.5rem minmax(4rem, 16rem) 4.25rem 3.75rem 3.5rem 9.5rem" }}
      >
        <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 14 }}>
          {node.children.length ? (
            <button
              type="button"
              aria-label={`${expanded ? "Hide" : "Show"} ${node.name}`}
              className="w-4 shrink-0 text-white/40"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(node);
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <button
            type="button"
            className="min-w-0 truncate text-left font-medium"
            onClick={(event) => {
              event.stopPropagation();
              onPick(node.id);
            }}
          >
            <span data-name>{node.name}</span>
          </button>
        </div>
        <span data-chip className={`justify-self-start rounded-full px-1.5 py-0.5 text-[11px] ${CHIP[node.state].className}`}>
          {CHIP[node.state].label}
        </span>
        <span className="min-w-0 truncate text-white/55">{node.task ?? ""}</span>
        <span data-cost className="text-right text-[12px] tabular-nums text-white/50">{node.costLabel ?? ""}</span>
        <span data-time className="text-right text-[12px] text-white/50">{node.timeLabel ?? ""}</span>
        <span data-pr className="text-right text-[12px] text-white/70">{node.prNumber ? `#${node.prNumber}` : ""}</span>
        <span data-checks className="truncate text-[12px] text-white/55">{node.checksLabel ?? ""}</span>
      </div>
      {showKids
        ? node.children.map((child) => (
            <Rows key={child.id} node={child} depth={depth + 1} now={now} open={open} selected={selected} onPick={onPick} onToggle={onToggle} />
          ))
        : null}
    </>
  );
}
