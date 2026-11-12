// WP-71: board, list and timeline for one project, and for every project. A failed load keeps the list.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pathKey } from "../../../shared/lib/paths";
import { takeHomeTask } from "../../home/model/pending";
import { readTaskCommits, type TaskCommit } from "../../attribution/read";
import { peekTaskFocus, subscribeTaskFocus } from "../../search/model/finderOpen";
import { hubData } from "../../hub/model/hubData";
import { setHubSelection } from "../../hub/model/hubNav";
import { nextDetail, nextTasks } from "../model/keep";
import { runBulk } from "../model/bulk";
import { taskMatches, type MatchTask } from "../model/match";
import {
  isAgentTask,
  labelsOf,
  membersOf,
  projectsOf,
  readStatuses,
  readStoreTask,
  readStoreTasks,
  toOrbitTasks,
  type StoreTask,
} from "../model/mapTask";
import { statusProjectIds, taskProjectKeys } from "../model/projects";
import { readViewState, saveWasStale } from "../model/viewKeep";
import { PRIORITY_ORDER } from "../vendor/taskMeta";
import type { Task, TaskStatusDef } from "../vendor/models";
import { createAutosaver } from "../vendor/views/autosave";
import type { GroupContext } from "../vendor/views/grouping";
import { defaultViewState, isGroup, type FilterGroup, type GroupBy, type OrderBy, type ViewState } from "../vendor/views/viewState";
import { BulkBar } from "./BulkBar";
import { PickupRules } from "./PickupRules";
import { TaskBoard } from "./TaskBoard";
import { TaskDetail } from "./TaskDetail";
// WP-84: phase documents and the review decision live on the open task.
import { answerWork, changePath, commentId, noteDocComment, noteTaskComment, phaseFor, subscribePhase } from "../../phases/model/store";
import { TaskList } from "./TaskList";
import { TaskTimeline } from "./TaskTimeline";
import { stackUrlFor } from "../../stacks/model/link";
import { spendPulse, subscribeSpend, taskCeilingNote } from "../../usage/model/spendGate";

type Scope = "all" | "project";

type HeldView = {
  id: string;
  name: string;
  state: ViewState;
  version: number;
  builtin: boolean;
};

type Written = { stale: boolean; task: StoreTask | null };

const CHANGED = "tasks://changed";
const GROUPS: readonly GroupBy[] = ["status", "assignee", "priority", "project", "label", "none"];

function person(project: string) {
  return { id: "person", project, kind: "person" };
}

function pageKeyFor(scope: Scope, projectId: string): string {
  return scope === "all" ? "all" : `project:${projectId}`;
}

function keysFor(scope: Scope, cwd: string): { write: string; read: string[] } {
  const projects = hubData().listProjects().map((project) => ({ id: project.id, folder: project.folder ?? null }));
  const own = taskProjectKeys(cwd, projects);
  if (scope === "project") return own;
  const read: string[] = [];
  for (const project of projects) {
    for (const key of taskProjectKeys(project.folder || project.id, projects).read) {
      if (!read.includes(key)) read.push(key);
    }
  }
  for (const key of own.read) if (!read.includes(key)) read.push(key);
  return { write: own.write, read };
}

function readOneView(value: unknown): HeldView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "" || typeof row.name !== "string" || row.name.trim() === "") return null;
  return {
    id: row.id,
    name: row.name,
    state: readViewState(row.state),
    version: typeof row.version === "number" && Number.isFinite(row.version) ? row.version : 1,
    builtin: row.builtin === true,
  };
}

function readViews(value: unknown): HeldView[] {
  if (!Array.isArray(value)) return [];
  const views: HeldView[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const view = readOneView(item);
    if (!view || seen.has(view.id)) continue;
    seen.add(view.id);
    views.push(view);
  }
  return views;
}

function readWritten(value: unknown): Written | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { stale?: unknown; task?: unknown };
  return { stale: row.stale === true, task: readStoreTask(row.task) };
}

function textOf(filter: FilterGroup): string {
  for (const child of filter.children) {
    if (!isGroup(child) && child.field === "text" && child.operator === "contains" && typeof child.value === "string") return child.value;
  }
  return "";
}

function withText(filter: FilterGroup, text: string): FilterGroup {
  const children = filter.children.filter((child) => isGroup(child) || child.field !== "text");
  const query = text.trim();
  if (query === "") return { ...filter, children };
  return { ...filter, children: [...children, { field: "text", operator: "contains", value: query }] };
}

function matchOf(task: StoreTask, statuses: readonly TaskStatusDef[], subIssueCount: number): MatchTask {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    category: statuses.find((status) => status.projectId === task.projectId && status.name === task.status)?.category,
    priority: task.priority,
    assignee: task.assignee,
    projectId: task.projectId,
    labels: task.labels,
    parentId: task.parentId,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    subIssueCount,
    creatorId: task.createdBy,
  };
}

function sortTasks(tasks: Task[], order: OrderBy, direction: "asc" | "desc"): Task[] {
  if (order === "manual") return tasks;
  const factor = direction === "desc" ? -1 : 1;
  return [...tasks].sort((a, b) => {
    const diff =
      order === "title"
        ? a.title.localeCompare(b.title)
        : order === "priority"
          ? PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
          : order === "created"
            ? a.createdAt.localeCompare(b.createdAt)
            : order === "updated"
              ? a.updatedAt.localeCompare(b.updatedAt)
              : (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿");
    return diff * factor || a.position - b.position;
  });
}

function mergeHeld(local: readonly HeldView[], listed: readonly HeldView[], keepIds: ReadonlySet<string>): HeldView[] {
  const localById = new Map(local.map((view) => [view.id, view]));
  const merged = listed.map((view) => {
    const have = localById.get(view.id);
    return have && have.version > view.version ? have : view;
  });
  for (const id of keepIds) {
    const have = localById.get(id);
    if (have && !merged.some((view) => view.id === id)) merged.push(have);
  }
  return merged;
}

function pickHeld(previous: HeldView | null, listed: readonly HeldView[], keepIds: ReadonlySet<string>): HeldView | null {
  const same = previous ? listed.find((view) => view.id === previous.id) : undefined;
  if (previous && same && previous.version > same.version) return previous;
  if (same) return same;
  if (previous && keepIds.has(previous.id)) return previous;
  return listed.find((view) => view.builtin) ?? listed[0] ?? previous;
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function TasksScreen({ cwd, scope = "project", rail = false }: { cwd: string; scope?: Scope; rail?: boolean }) {
  const [tasks, setTasks] = useState<StoreTask[] | null>(null);
  const [statuses, setStatuses] = useState<TaskStatusDef[]>([]);
  const [views, setViews] = useState<HeldView[]>([]);
  const [current, setCurrent] = useState<HeldView | null>(null);
  const [open, setOpen] = useState<StoreTask | null>(null);
  const [commits, setCommits] = useState<TaskCommit[]>([]);
  const [adding, setAdding] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [naming, setNaming] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [phaseTick, setPhaseTick] = useState(0);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // WP-176: the open task shows this project's ceiling, and a stopped run's reason.
  const spendWatch = useSyncExternalStore(subscribeSpend, spendPulse, () => "0");
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const seenFocus = useRef(0);
  const focus = useSyncExternalStore(subscribeTaskFocus, peekTaskFocus, () => null);
  useEffect(() => subscribePhase(() => setPhaseTick((tick) => tick + 1)), []);
  const bulkGeneration = useRef(0);
  const tasksRef = useRef(tasks);
  const openRef = useRef(open);
  const viewRef = useRef(current);
  const viewsRef = useRef(views);
  const freshIds = useRef(new Set<string>());
  const droppedIds = useRef(new Set<string>());
  const alive = useRef(true);
  const writeRef = useRef("");
  const pageRef = useRef("all");
  const saverRef = useRef<ReturnType<typeof createAutosaver<ViewState>> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  tasksRef.current = tasks;
  openRef.current = open;
  viewRef.current = current;
  viewsRef.current = views;

  useEffect(() => {
    let live = true;
    const requested = cwd;
    setAppUrl(null);
    const pull = () => {
      void stackUrlFor(requested).then((url) => {
        if (live) setAppUrl(url);
      });
    };
    pull();
    const pending = listen("stacks://changed", () => {
      if (live) pull();
    });
    return () => {
      live = false;
      void pending.then((done) => done());
    };
  }, [cwd]);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    const seenFresh = new Set(freshIds.current);
    const seenDropped = new Set(droppedIds.current);
    let keys: { write: string; read: string[] };
    let statusIds: string[] = [];
    try {
      const projects = hubData().listProjects().map((project) => ({ id: project.id, folder: project.folder ?? null }));
      keys = keysFor(scope, cwd);
      statusIds = statusProjectIds(scope, cwd, projects);
    } catch {
      if (gen !== generation.current) return;
      setTasks((previous) => nextTasks(previous, { ok: false }));
      setNote("Couldn't load tasks. Trying again.");
      return;
    }
    writeRef.current = keys.write;
    pageRef.current = pageKeyFor(scope, keys.write);
    if (keys.read.length === 0) {
      if (gen === generation.current) setNote("Name the project.");
      return;
    }
    try {
      const lists = await Promise.all(keys.read.map((key) => invoke("tasks_list", { actor: person(key) })));
      if (gen !== generation.current) return;
      const merged = readStoreTasks(lists.flat());
      setTasks(nextTasks(tasksRef.current, { ok: true, value: merged }));
      setNote(null);
    } catch {
      if (gen !== generation.current) return;
      setTasks((previous) => nextTasks(previous, { ok: false }));
      setNote("Couldn't load tasks. Trying again.");
    }
    const asked = statusIds.length > 0 ? statusIds : [keys.write];
    try {
      const lists = await Promise.all(
        asked.map(async (key) => {
          try {
            return await invoke("tasks_statuses", { actor: person(key) });
          } catch {
            return null;
          }
        }),
      );
      if (gen !== generation.current) return;
      const flat = lists.flatMap((rows) => (Array.isArray(rows) ? rows : []));
      setStatuses(readStatuses(flat, asked));
    } catch {
      if (gen === generation.current) setStatuses(readStatuses(null, asked));
    }
    try {
      const listed = await invoke("tasks_views_list", { actor: person(keys.write), pageKey: pageRef.current });
      if (gen !== generation.current) return;
      const arrived = new Set([...freshIds.current].filter((id) => !seenFresh.has(id)));
      const droppedDuring = new Set([...droppedIds.current].filter((id) => !seenDropped.has(id)));
      const next = readViews(listed).filter((item) => !droppedDuring.has(item.id));
      setViews((previous) => mergeHeld(previous, next, arrived));
      setCurrent((previous) => pickHeld(previous, next, arrived));
    } catch {
      // The view list is not the task list. A missing command leaves the tasks where they are.
    }
  }, [cwd, scope]);

  const refreshOpen = useCallback(async (id: string, projectId: string) => {
    const gen = ++detailGeneration.current;
    try {
      const task = readStoreTask(await invoke("tasks_get", { actor: person(projectId), id }));
      setOpen((previous) => nextDetail(previous, task ? { ok: true, value: task } : { ok: false }, gen, detailGeneration.current));
    } catch {
      setOpen((previous) => nextDetail(previous, { ok: false }, gen, detailGeneration.current));
      if (gen === detailGeneration.current) setNote("Couldn't load tasks. Trying again.");
    }
  }, []);

  // WP-74: the finder asks for a task. A request made before this pane was mounted still opens.
  useEffect(() => {
    if (!focus || focus.token === seenFocus.current) return;
    seenFocus.current = focus.token;
    void refreshOpen(focus.id, focus.project);
  }, [focus, refreshOpen]);

  useEffect(() => {
    void load();
    const pending = listen(CHANGED, () => {
      void load();
      const shown = openRef.current;
      if (shown) void refreshOpen(shown.id, shown.projectId);
    });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
      clearInterval(clock);
      void pending.then((done) => done());
    };
  }, [load, refreshOpen]);

  // WP-73: a task opened from Home waits until this list has it. The wrong pane, or a failed list, does not drop it.
  useEffect(() => {
    if (!tasks) return;
    const id = takeHomeTask(tasks.map((task) => task.id));
    if (!id) return;
    const task = tasks.find((item) => item.id === id);
    if (task) setOpen(task);
  }, [tasks]);

  // WP-86: this task's commits. A new task clears first. A failed read keeps the list.
  const commitKey = open ? `${open.id}\0${cwd}` : "";
  const [commitsFor, setCommitsFor] = useState(commitKey);
  if (commitsFor !== commitKey) {
    setCommitsFor(commitKey);
    setCommits([]);
  }
  useEffect(() => {
    if (!open) return;
    const key = `${open.id}\0${cwd}`;
    let cancelled = false;
    void invoke("attribution_for_task", { taskId: open.id, repo: cwd || null })
      .then((value) => {
        if (!cancelled && commitsFor === key) setCommits(readTaskCommits(value));
      })
      .catch(() => {
        // The rows already on screen stay.
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, commitsFor]);

  useEffect(() => {
    if (adding) titleRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && adding && (titleRef.current?.value ?? "").trim() === "") {
        event.preventDefault();
        setAdding(false);
        return;
      }
      if (typingTarget(event.target)) return;
      if (event.key === "c" && !adding) {
        event.preventDefault();
        setAdding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding]);

  const persistRef = useRef<(state: ViewState) => Promise<void>>(async () => undefined);
  persistRef.current = async (state) => {
    const view = viewRef.current;
    const project = writeRef.current;
    const pageAtSave = pageRef.current;
    if (!view?.id || project === "") throw new Error("offline");
    const written = (await invoke("tasks_views_save", {
      actor: person(project),
      input: { pageKey: pageAtSave, id: view.id, name: view.name, state, version: view.version },
    })) as { stale?: unknown; view?: unknown };
    const saved = readOneView(written?.view);
    if (!saved) throw new Error("offline");
    // A save started on the way out, or for a page we have already left, must not land on the page now showing.
    if (!alive.current || pageRef.current !== pageAtSave) return;
    freshIds.current.add(saved.id);
    viewRef.current = saved;
    setCurrent(saved);
    setViews((previous) => previous.map((item) => (item.id === saved.id ? saved : item)));
  };
  useEffect(() => {
    const saver = createAutosaver<ViewState>((state) => persistRef.current(state));
    saverRef.current = saver;
    return () => {
      saver.flush();
      saver.dispose();
      if (saverRef.current === saver) saverRef.current = null;
    };
  }, [cwd, scope]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function changeView(next: ViewState) {
    const state = readViewState(next);
    setCurrent((previous) => (previous ? { ...previous, state } : previous));
    if (viewRef.current?.id) saverRef.current?.schedule(state);
  }

  async function write(task: StoreTask, fields: Record<string, unknown>) {
    if (isAgentTask(task) && "status" in fields) {
      setNote("This task follows its work.");
      return;
    }
    try {
      const written = readWritten(
        await invoke("tasks_update", { actor: person(task.projectId), input: { id: task.id, version: task.version, ...fields } }),
      );
      if (written?.task && openRef.current?.id === written.task.id) setOpen(written.task);
      await load();
      if (written?.stale) setNote("That task changed. Showing the latest.");
    } catch {
      setNote("Couldn't load tasks. Trying again.");
    }
  }

  async function create(title: string, assignee: string) {
    let keys: { write: string; read: string[] };
    try {
      keys = keysFor(scope, cwd);
    } catch {
      setNote("Couldn't load tasks. Trying again.");
      return;
    }
    if (!keys.write || title.trim() === "") return;
    try {
      const written = readWritten(
        await invoke("tasks_create", {
          actor: person(keys.write),
          input: { title: title.trim(), ...(assignee ? { assignee } : {}) },
        }),
      );
      if (written?.task) setOpen(written.task);
      setAdding(false);
      await load();
    } catch {
      setNote("Couldn't load tasks. Trying again.");
    }
  }

  async function bulk(fields: Record<string, unknown>) {
    const gen = ++bulkGeneration.current;
    const chosen = (tasksRef.current ?? []).filter((task) => selected.has(task.id));
    let followed = false;
    const result = await runBulk(
      chosen,
      async (task) => {
        if (isAgentTask(task) && "status" in fields) {
          followed = true;
          return "ok";
        }
        try {
          const written = readWritten(
            await invoke("tasks_update", { actor: person(task.projectId), input: { id: task.id, version: task.version, ...fields } }),
          );
          if (!written) return "missing";
          return written.stale ? "stale" : "ok";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.toLowerCase().includes("no task")) return "missing";
          throw error;
        }
      },
      () => gen === bulkGeneration.current,
    );
    if (gen !== bulkGeneration.current) return;
    await load();
    if (gen !== bulkGeneration.current) return;
    if (result === "stale") setNote("That task changed. Showing the latest.");
    else if (result === "unreachable") setNote("Couldn't load tasks. Trying again.");
    else if (followed) setNote("This task follows its work.");
  }

  async function saveCopy(name: string) {
    const trimmed = name.trim();
    if (trimmed === "" || writeRef.current === "") return;
    try {
      const written = (await invoke("tasks_views_save", {
        actor: person(writeRef.current),
        input: { pageKey: pageRef.current, name: trimmed, state: (current ?? { state: defaultViewState() }).state },
      })) as { view?: unknown };
      const saved = readOneView(written.view);
      if (!saved) return;
      freshIds.current.add(saved.id);
      viewRef.current = saved;
      setViews((previous) => [...previous.filter((view) => view.id !== saved.id), saved]);
      setCurrent(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNote(message.trim() || "Couldn't load tasks. Trying again.");
    }
  }

  async function deleteView(view: HeldView) {
    if (view.builtin) return;
    try {
      const written = (await invoke("tasks_views_delete", {
        actor: person(writeRef.current),
        id: view.id,
        version: view.version,
      })) as { stale?: unknown; view?: unknown } | null;
      if (!written || typeof written !== "object") {
        setNote("Couldn't load tasks. Trying again.");
        return;
      }
      if (saveWasStale({ stale: written.stale === true })) {
        const saved = readOneView(written.view);
        if (saved) {
          viewRef.current = saved;
          setViews((previous) => previous.map((item) => (item.id === saved.id ? saved : item)));
          setCurrent((previous) => (previous?.id === saved.id ? saved : previous));
        }
        setNote("That view changed. Showing the latest.");
        return;
      }
      droppedIds.current.add(view.id);
      const rest = viewsRef.current.filter((item) => item.id !== view.id);
      const next = viewRef.current?.id === view.id ? (rest.find((item) => item.builtin) ?? rest[0] ?? null) : (viewRef.current ?? null);
      viewRef.current = next;
      setViews(rest);
      setCurrent(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNote(message.trim() || "Couldn't load tasks. Trying again.");
    }
  }

  const state = current?.state ?? defaultViewState();
  const display = state.display;
  const loaded = tasks ?? [];
  const storeById = new Map(loaded.map((task) => [task.id, task]));
  const orbit = toOrbitTasks(loaded, statuses, now);
  const visible = sortTasks(
    orbit.filter((task) => {
      const store = storeById.get(task.id);
      return store ? taskMatches(matchOf(store, statuses, task.subIssueCount ?? 0), state.filter, { currentUserId: "person" }) : false;
    }),
    display.order_by,
    display.order_direction,
  );
  const items = visible.flatMap((task) => {
    const store = storeById.get(task.id);
    return store ? [{ store, orbit: task }] : [];
  });
  const projectIds = [...new Set(loaded.map((task) => task.projectId).concat(statuses.map((status) => status.projectId)))];
  const context: GroupContext = {
    statuses,
    members: membersOf(loaded),
    labels: labelsOf(loaded),
    projects: projectsOf(projectIds),
    currentUserId: "person",
    showEmpty: display.show_empty_groups,
  };
  const hubProject = hubData()
    .listProjects()
    .find((project) => (project.folder ? pathKey(project.folder) === pathKey(cwd) : false) || project.id === cwd);

  return (
    <section aria-label="Tasks" className={rail ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-4 py-3" : "mt-3 border-t border-stroke px-3 py-2"}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[12px] text-content/70">Tasks</h2>
        {(["list", "board", "timeline"] as const).map((layout) => (
          <button
            key={layout}
            type="button"
            aria-pressed={display.layout === layout}
            className="text-[12px] text-content/80"
            onClick={() => changeView({ ...state, display: { ...display, layout } })}
          >
            {layout === "list" ? "List" : layout === "board" ? "Board" : "Timeline"}
          </button>
        ))}
        <label className="text-[12px] text-content/70">
          Group by
          <select
            aria-label="Group by"
            className="ml-1 bg-transparent text-content"
            value={GROUPS.includes(display.group_by) ? display.group_by : "status"}
            onChange={(event) => changeView({ ...state, display: { ...display, group_by: event.target.value as GroupBy } })}
          >
            {GROUPS.map((group) => (
              <option key={group} value={group}>
                {group === "none" ? "None" : group[0]?.toUpperCase() + group.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {showFilter || textOf(state.filter) !== "" ? (
          <input
            aria-label="Filter"
            value={textOf(state.filter)}
            placeholder="Filter"
            className="w-28 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
            onChange={(event) => changeView({ ...state, filter: withText(state.filter, event.target.value) })}
          />
        ) : (
          <button type="button" className="text-[12px] text-content/70" onClick={() => setShowFilter(true)}>
            Filter
          </button>
        )}
        {views.length > 0 ? (
          <select
            aria-label="Saved view"
            className="bg-transparent text-[12px] text-content"
            value={current?.id ?? ""}
            onChange={(event) => setCurrent(views.find((view) => view.id === event.target.value) ?? current)}
          >
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        ) : null}
        {naming ? (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void saveCopy(String(data.get("name") ?? ""));
              event.currentTarget.reset();
              setNaming(false);
            }}
          >
            <input name="name" aria-label="View name" placeholder="View name" className="w-28 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content" />
            <button type="submit" className="text-[12px] text-content/70">
              Save view
            </button>
          </form>
        ) : (
          <button type="button" className="text-[12px] text-content/70" onClick={() => setNaming(true)}>
            Save view
          </button>
        )}
        {current && !current.builtin ? (
          <button type="button" className="text-[12px] text-content/70" onClick={() => void deleteView(current)}>
            Delete view
          </button>
        ) : null}
        {rail && hubProject ? (
          <button
            type="button"
            className="text-[12px] text-content/70"
            onClick={() => setHubSelection({ project: hubProject.id, item: scope === "all" ? "tasks" : "all-tasks" })}
          >
            {scope === "all" ? "This project" : "All tasks"}
          </button>
        ) : null}
      </div>
      {note ? <p className="mt-1 text-[12px] text-content/70">{note}</p> : null}
      {tasks === null && !note ? <p className="mt-1 text-[12px] text-content/70">Loading tasks.</p> : null}
      {tasks && items.length === 0 ? <p className="mt-1 text-[12px] text-content/70">No tasks.</p> : null}
      <div className={rail ? "flex min-h-0 flex-1 gap-4" : ""}>
        <div className="min-w-0 flex-1">
          {display.layout === "board" ? (
            <TaskBoard items={items} display={display} statuses={statuses} context={context} onOpen={(id) => void refreshOpen(id, storeById.get(id)?.projectId ?? writeRef.current)} onWrite={(task, fields) => void write(task, fields)} onNote={setNote} />
          ) : null}
          {display.layout === "list" ? (
            <TaskList
              items={items}
              display={display}
              statuses={statuses}
              context={context}
              selected={selected}
              onSelect={(id, on) =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
              onOpen={(id) => void refreshOpen(id, storeById.get(id)?.projectId ?? writeRef.current)}
              onWrite={(task, fields) => void write(task, fields)}
            />
          ) : null}
          {display.layout === "timeline" ? (
            <TaskTimeline tasks={visible} display={display} statuses={statuses} context={context} onOpen={(id) => void refreshOpen(id, storeById.get(id)?.projectId ?? writeRef.current)} />
          ) : null}
          {display.layout === "list" ? (
            <BulkBar
              count={selected.size}
              statuses={statuses}
              onStatus={(status) => void bulk({ status })}
              onPriority={(priority) => void bulk({ priority })}
              onAssignee={(assignee) => void bulk({ assignee: assignee || null })}
              onLabels={(labels) => void bulk({ labels })}
            />
          ) : null}
        </div>
        {open ? (
          <div className={rail ? "w-80 shrink-0" : "mt-2"}>
            <TaskDetail
              task={open}
              now={now}
              parentTitle={open.parentId ? loaded.find((task) => task.id === open.parentId)?.title ?? null : null}
              subtasks={loaded.filter((task) => task.parentId === open.id).map((task) => ({ number: task.number, title: task.title, status: task.status }))}
              onComment={(text) => {
                void write(open, { comment: text });
                // WP-84: a comment on the task reaches the next phase run.
                noteTaskComment(open.id, text, commentId());
              }}
              phase={phaseTick >= 0 ? phaseFor(open.id) : undefined}
              onPhaseAnswer={(choice, words) => {
                void answerWork(open.id, choice, words, commentId);
              }}
              onPhasePath={(path) => {
                void changePath(open.id, path, commentId);
              }}
              onPhaseDocComment={(docNumber, text) => noteDocComment(open.id, docNumber, text, commentId())}
              onStatus={(status) => void write(open, { status })}
              onPriority={(priority) => void write(open, { priority })}
              onAssign={(assignee) => void write(open, { assignee: assignee || null })}
              onOpenChat={(id) => window.dispatchEvent(new CustomEvent("hivra:open-task-chat", { detail: id }))}
              commits={commits}
              appUrl={appUrl}
              ceiling={spendWatch ? taskCeilingNote(open.projectId ?? cwd, open.chatId) : null}
            />
          </div>
        ) : null}
      </div>
      {adding ? (
        <form
          className="mt-2 flex gap-1.5"
          aria-label="New task"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const title = String(data.get("title") ?? "");
            if (!title.trim()) return;
            void create(title, String(data.get("assignee") ?? "").trim());
            event.currentTarget.reset();
          }}
        >
          <input
            ref={titleRef}
            name="title"
            aria-label="Task title"
            className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
          />
          <input
            name="assignee"
            aria-label="New task assignee"
            placeholder="Assignee"
            className="w-28 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
          />
          <button type="submit" className="text-[12px] text-content/70">
            Add task
          </button>
        </form>
      ) : (
        <button type="button" className="mt-2 text-[12px] text-content/70" onClick={() => setAdding(true)}>
          Add task
        </button>
      )}
      <PickupRules project={writeRef.current} />
    </section>
  );
}
