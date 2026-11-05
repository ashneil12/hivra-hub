// WP-70: the tasks of this project, under the crew. A failed load keeps the last list.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hubData } from "../../hub/model/hubData";
import { takeHomeTask } from "../../home/model/pending";
import { nextDetail, nextTasks } from "../model/keep";
import { taskProjectKeys } from "../model/projects";
import { TaskDetail, type TaskDetailTask } from "./TaskDetail";

type StoreTask = TaskDetailTask & {
  id: string;
  projectId: string;
  version: number;
};

type Written = { stale: boolean; task: StoreTask };

const CHANGED = "tasks://changed";

function person(project: string) {
  return { id: "person", project, kind: "person" };
}

function detailOf(task: StoreTask): TaskDetailTask {
  return task;
}

export function TaskPane({ project }: { project: string }) {
  const [tasks, setTasks] = useState<StoreTask[] | null>(null);
  const [open, setOpen] = useState<StoreTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const tasksRef = useRef(tasks);
  const openRef = useRef(open);
  tasksRef.current = tasks;
  openRef.current = open;

  const load = useCallback(async () => {
    const gen = ++generation.current;
    let keys: ReturnType<typeof taskProjectKeys>;
    try {
      keys = taskProjectKeys(project, hubData().listProjects());
    } catch {
      if (gen !== generation.current) return;
      setTasks((previous) => nextTasks(previous, { ok: false }));
      setNote("Couldn't load tasks. Trying again.");
      return;
    }
    if (keys.read.length === 0) {
      setNote("Name the project.");
      return;
    }
    try {
      const lists = await Promise.all(
        keys.read.map((key) => invoke<StoreTask[]>("tasks_list", { actor: person(key) })),
      );
      if (gen !== generation.current) return;
      const merged: StoreTask[] = [];
      for (const list of lists) {
        for (const task of list) {
          if (!merged.some((kept) => kept.id === task.id)) merged.push(task);
        }
      }
      setTasks(nextTasks(tasksRef.current, { ok: true, value: merged }));
      setNote(null);
    } catch {
      if (gen !== generation.current) return;
      setTasks((previous) => nextTasks(previous, { ok: false }));
      setNote("Couldn't load tasks. Trying again.");
    }
  }, [project]);

  const refreshOpen = useCallback(async (id: string, projectId: string) => {
    const gen = ++detailGeneration.current;
    try {
      const task = await invoke<StoreTask>("tasks_get", { actor: person(projectId), id });
      setOpen((previous) => nextDetail(previous, { ok: true, value: task }, gen, detailGeneration.current));
    } catch {
      setOpen((previous) => nextDetail(previous, { ok: false }, gen, detailGeneration.current));
      if (gen === detailGeneration.current) setNote("Couldn't load tasks. Trying again.");
    }
  }, []);

  useEffect(() => {
    void load();
    const pending = listen(CHANGED, () => {
      void load();
      const current = openRef.current;
      if (current) void refreshOpen(current.id, current.projectId);
    });
    return () => {
      generation.current += 1;
      detailGeneration.current += 1;
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

  async function create(title: string, assignee: string) {
    const keys = taskProjectKeys(project, hubData().listProjects());
    if (!keys.write) return;
    try {
      const written = await invoke<Written>("tasks_create", {
        actor: person(keys.write),
        input: { title, ...(assignee ? { assignee } : {}) },
      });
      setNote(null);
      setOpen(written.task);
      await load();
    } catch {
      setNote("Couldn't load tasks. Trying again.");
    }
  }

  async function change(input: Record<string, unknown>) {
    const current = openRef.current;
    if (!current) return;
    try {
      const written = await invoke<Written>("tasks_update", {
        actor: person(current.projectId),
        input: { id: current.id, version: current.version, ...input },
      });
      setOpen(written.task);
      setNote(written.stale ? "That task changed. Showing the latest." : null);
      await load();
    } catch {
      setNote("Couldn't load tasks. Trying again.");
    }
  }

  return (
    <section aria-label="Tasks" className="mt-3 border-t border-stroke px-3 py-2">
      <h2 className="text-[12px] text-content/70">Tasks</h2>
      {note ? <p className="mt-1 text-[12px] text-content/70">{note}</p> : null}
      {tasks === null && !note ? <p className="mt-1 text-[12px] text-content/70">Loading tasks.</p> : null}
      {tasks && tasks.length === 0 ? <p className="mt-1 text-[12px] text-content/70">No tasks.</p> : null}
      <ul className="mt-1">
        {(tasks ?? []).map((task) => (
          <li key={task.id}>
            <button type="button" className="text-[12px] text-content/80" onClick={() => void refreshOpen(task.id, task.projectId)}>
              #{task.number} {task.title}
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <TaskDetail
          task={detailOf(open)}
          onComment={(text) => void change({ comment: text })}
          onStatus={(status) => void change({ status })}
          onAssign={(assignee) => void change({ assignee: assignee || null })}
        />
      ) : null}
      {adding ? (
        <form
          className="mt-2 flex gap-1.5"
          aria-label="New task"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const title = String(data.get("title") ?? "").trim();
            if (!title) return;
            void create(title, String(data.get("assignee") ?? "").trim());
            event.currentTarget.reset();
            setAdding(false);
          }}
        >
          <input
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
    </section>
  );
}
