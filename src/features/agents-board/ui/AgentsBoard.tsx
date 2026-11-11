// The one Agents board. A row opens its chat read-only: no composer, one Stop that asks once.
// Stop stays on the row it was asked for. It says Stopped only after the stop succeeds.

import { useEffect, useMemo, useRef, useState } from "react";
import { boardChipCounts } from "../model/counts";
import { loadOpenMap, rowOpen, saveOpenMap, type OpenMap } from "../model/expand";
import { filterBoard, settledToday, type BoardFilter, type BoardStateFilter } from "../model/filter";
import { cancelStop, confirmStop, finishStop, requestStop, stopFailureText, stopTarget, type StopPhase } from "../model/stop";
import { descendantOwnCount, flattenBoard, type BoardNode, type BoardState } from "../model/tree";
import { rollupText } from "../model/words";

const CHIP: Record<BoardState, { label: string; own: string }> = {
  "needs-you": { label: "Needs you", own: "border border-transparent bg-[#e5484d]/15 text-[#e5484d]" },
  working: { label: "Working", own: "border border-transparent bg-[#3b82f6]/15 text-[#60a5fa]" },
  done: { label: "Done", own: "border border-transparent bg-emerald-400/15 text-emerald-300" },
  idle: { label: "Idle", own: "border border-transparent bg-white/10 text-white/45" },
};

const COLUMNS = "14rem 15.5rem minmax(4rem, 1fr) 4.75rem 4.25rem 3.75rem 9rem";

type StopEntry = { phase: StopPhase; error?: string; quiet?: boolean };

export function AgentsBoard({
  tree,
  projects,
  now,
  lines,
  onStop,
  onOpen,
  initialOpen,
}: {
  tree: BoardNode;
  projects: readonly { id: string; name: string }[];
  now: number;
  lines: Record<string, readonly string[]>;
  onStop: (id: string) => void | Promise<void>;
  onOpen: (id: string) => void;
  initialOpen?: OpenMap;
}) {
  const [filter, setFilter] = useState<BoardFilter>({ projectId: null, state: null });
  const [open, setOpen] = useState<OpenMap>(() => ({ ...initialOpen, ...loadOpenMap() }));
  const [selected, setSelected] = useState<string | null>(null);
  const [stops, setStops] = useState<Record<string, StopEntry>>({});
  const stopGen = useRef<Record<string, number>>({});
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const shown = useMemo(() => filterBoard(tree, filter, now), [tree, filter, now]);
  const counts = useMemo(() => boardChipCounts(tree, filter.projectId, now), [tree, filter.projectId, now]);
  const ids = useMemo(() => flattenBoard(shown).map((node) => node.id), [shown]);
  const current = selected ? flattenBoard(shown).find((node) => node.id === selected) ?? null : null;
  const entry = current ? stops[current.id] ?? { phase: "closed" as StopPhase } : { phase: "closed" as StopPhase };
  const asking = entry.phase === "asking" && current != null;

  // Stopped stays until this row has been quiet and then starts working again.
  // A row that is still working when the stop lands keeps Stopped; clearing it there would hide the result.
  useEffect(() => {
    const nodes = new Map(flattenBoard(tree).map((node) => [node.id, node]));
    setStops((prev) => {
      let changed = false;
      const next: Record<string, StopEntry> = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (entry.phase !== "stopped") {
          next[id] = entry;
          continue;
        }
        const node = nodes.get(id);
        if (!node) {
          next[id] = entry;
          continue;
        }
        if (node.ownState !== "working") {
          if (entry.quiet) next[id] = entry;
          else {
            next[id] = { ...entry, quiet: true };
            changed = true;
          }
          continue;
        }
        if (entry.quiet) {
          changed = true;
          continue;
        }
        next[id] = entry;
      }
      return changed ? next : prev;
    });
  }, [tree]);

  function pick(id: string) {
    setSelected(id);
  }

  function toggle(node: BoardNode) {
    setOpen((prev) => {
      const next = { ...prev, [node.id]: !rowOpen(node.id, node.role, prev) };
      saveOpenMap(next);
      return next;
    });
  }

  function askStop() {
    if (!current) return;
    const id = current.id;
    setStops((prev) => {
      const next = requestStop(prev[id]?.phase ?? "closed");
      return { ...prev, [id]: { phase: next.phase } };
    });
  }

  function confirm() {
    if (!current) return;
    const id = current.id;
    const name = current.name;
    const phase = stops[id]?.phase ?? "closed";
    const next = confirmStop(phase);
    const target = stopTarget(id, ids);
    if (!next.stop || !target) {
      setStops((prev) => ({ ...prev, [id]: { phase: "closed" } }));
      return;
    }
    const gen = (stopGen.current[id] ?? 0) + 1;
    stopGen.current[id] = gen;
    setStops((prev) => ({ ...prev, [id]: { phase: "stopping" } }));
    void Promise.resolve()
      .then(() => onStop(target))
      .then(
        () => {
          if (stopGen.current[id] !== gen) return;
          setStops((prev) => {
            const nowPhase = prev[id]?.phase ?? "closed";
            const phase = finishStop(nowPhase, true);
            if (phase === nowPhase) return prev;
            const node = flattenBoard(treeRef.current).find((item) => item.id === id);
            return {
              ...prev,
              [id]: { phase, quiet: phase === "stopped" && !!node && node.ownState !== "working" },
            };
          });
        },
        (error: unknown) => {
          if (stopGen.current[id] !== gen) return;
          const reason = error instanceof Error ? error.message : "";
          setStops((prev) => {
            const nowPhase = prev[id]?.phase ?? "closed";
            if (finishStop(nowPhase, false) === nowPhase) return prev;
            return { ...prev, [id]: { phase: "failed", error: stopFailureText(name, reason) } };
          });
        },
      );
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
        <div
          role="tree"
          aria-label="Agents"
          className="grid min-w-0 flex-1 content-start gap-x-3 overflow-auto px-3 py-2"
          style={{ gridTemplateColumns: COLUMNS }}
        >
          <div
            data-board-head
            className="grid items-center pb-1 text-[11px] text-white/35"
            style={{ gridColumn: "1 / -1", gridTemplateColumns: "subgrid" }}
          >
            <span />
            <span />
            <span data-head="task">Task</span>
            <span data-head="cost" className="text-right">Cost</span>
            <span data-head="time" className="text-right">Time</span>
            <span data-head="pr" className="text-right">PR</span>
            <span data-head="checks">Checks</span>
          </div>
          <Rows node={shown} depth={0} now={now} open={open} selected={selected} onPick={pick} onToggle={toggle} onOpen={onOpen} />
        </div>
        {current ? (
          <aside data-readonly-chat className="flex w-[380px] shrink-0 flex-col border-l border-white/10">
            <div className="border-b border-white/10 px-4 py-3">
              <p className="text-[14px] font-medium">{current.name}</p>
              <p className="mt-1 text-[12px] text-white/50">{chipText(current)}</p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-3 text-[13px] leading-5 text-white/80">
              {(lines[current.id] ?? []).length ? (
                (lines[current.id] ?? []).map((line, index) => <p key={index}>{line}</p>)
              ) : (
                <p className="text-white/45">No messages in this chat yet.</p>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-white/10 px-4 py-3">
              {current.ownState === "needs-you" ? (
                <button type="button" className="w-fit rounded-md border border-white/15 px-3 py-1.5 text-[13px]" onClick={() => onOpen(current.id)}>
                  Open to answer
                </button>
              ) : null}
              {asking ? (
                <div role="dialog" aria-label="Stop this chat" data-stop-ask className="flex items-center gap-2">
                  <p className="mr-auto text-[13px]">Stop {current.name}?</p>
                  <button type="button" className="rounded-md bg-[#e5484d] px-3 py-1.5 text-[13px] text-white" onClick={confirm}>
                    Stop
                  </button>
                  <button type="button" className="rounded-md px-3 py-1.5 text-[13px] text-white/70" onClick={() => setStops((prev) => ({ ...prev, [current.id]: { phase: cancelStop(entry.phase) } }))}>
                    Cancel
                  </button>
                </div>
              ) : entry.phase === "stopping" ? (
                <p className="text-[13px] text-white/70">Stopping...</p>
              ) : entry.phase === "stopped" ? (
                <p className="text-[13px] text-white/70">Stopped</p>
              ) : entry.phase === "failed" ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-[13px] text-[#e5484d]">{entry.error}</p>
                  {current.canStop ? (
                    <button type="button" className="rounded-md border border-white/15 px-3 py-1.5 text-[13px]" onClick={askStop}>
                      Stop
                    </button>
                  ) : null}
                </div>
              ) : current.canStop ? (
                <button type="button" className="w-fit rounded-md border border-white/15 px-3 py-1.5 text-[13px]" onClick={askStop}>
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

function chipText(node: BoardNode): string {
  const own = CHIP[node.ownState].label;
  const under = rollupLine(node);
  return under ? `${own}. ${under}` : own;
}

function rollupLine(node: BoardNode): string | null {
  if (!node.rolledUp) return null;
  return rollupText(descendantOwnCount(node, node.state), node.state);
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
  onOpen,
}: {
  node: BoardNode;
  depth: number;
  now: number;
  open: OpenMap;
  selected: string | null;
  onPick: (id: string) => void;
  onToggle: (node: BoardNode) => void;
  onOpen: (id: string) => void;
}) {
  const expanded = rowOpen(node.id, node.role, open);
  const showKids = expanded && node.children.length > 0;
  const doneToday = node.state === "done" && settledToday(node.settledAt, now);
  const under = rollupLine(node);
  const own = CHIP[node.ownState];
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.children.length ? expanded : undefined}
        data-node={node.id}
        data-role={node.role}
        data-state={node.state}
        data-rolled={node.rolledUp ? "true" : "false"}
        data-done-today={doneToday ? "true" : "false"}
        onClick={() => onPick(node.id)}
        className={`grid cursor-pointer items-center py-2 text-[13px] ${selected === node.id ? "bg-white/8" : "hover:bg-white/5"}`}
        style={{ gridColumn: "1 / -1", gridTemplateColumns: "subgrid" }}
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
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-chip={under ? undefined : ""}
            data-rolled={under ? undefined : node.rolledUp ? "true" : "false"}
            data-own-chip={under ? "" : undefined}
            className={`inline-flex w-[6.5rem] shrink-0 justify-center rounded-full px-1.5 py-0.5 text-[11px] ${own.own}`}
          >
            {own.label}
          </span>
          {node.ownState === "needs-you" ? (
            <button
              type="button"
              className="shrink-0 rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-white/80"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(node.id);
              }}
            >
              Open
            </button>
          ) : null}
          {under ? (
            <span
              data-chip
              data-rolled="true"
              title="From a row under it"
              className={`flex min-w-0 items-center gap-1 truncate text-[11px] ${node.state === "needs-you" ? "text-[#e5484d]" : "text-white/45"}`}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
              {under}
            </span>
          ) : null}
        </div>
        <span data-task className="min-w-0 truncate text-white/55">{node.task ?? ""}</span>
        <span data-cost className="text-right text-[12px] tabular-nums text-white/50">{node.costLabel ?? ""}</span>
        <span data-time className="text-right text-[12px] text-white/50">{node.timeLabel ?? ""}</span>
        <span data-pr className="text-right text-[12px] text-white/70">{node.prNumber ? `#${node.prNumber}` : ""}</span>
        <span data-checks className="truncate text-[12px] text-white/55">{node.checksLabel ?? ""}</span>
      </div>
      {showKids
        ? node.children.map((child) => (
            <Rows key={child.id} node={child} depth={depth + 1} now={now} open={open} selected={selected} onPick={onPick} onToggle={onToggle} onOpen={onOpen} />
          ))
        : null}
    </>
  );
}
