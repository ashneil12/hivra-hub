// WP-85. Read a terminal session, reply, stop, answer a permission, or attach it to a task.
// Tool calls and diffs are shown only. A reply waits for the next turn.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import { terminalStateLabel } from "../model/list";

export type MirrorTask = { id: string; number: number; title: string };

function asTasks(value: unknown): MirrorTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: MirrorTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; number?: unknown; title?: unknown };
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    if (typeof row.number !== "number" || !Number.isFinite(row.number)) continue;
    tasks.push({ id: row.id, number: row.number, title: typeof row.title === "string" ? row.title : "Task" });
  }
  return tasks;
}

export function TerminalMirrorPane({
  session,
  tasks,
  projectId,
  note,
  onReply,
  onStop,
  onAllow,
  onDeny,
  onAttach,
  onClose,
}: {
  session: TerminalSession;
  tasks?: readonly MirrorTask[];
  projectId?: string;
  note?: string | null;
  onReply: (text: string) => void;
  onStop: () => void;
  onAllow: () => void;
  onDeny: () => void;
  onAttach: (taskId: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [taskId, setTaskId] = useState("");
  const [loaded, setLoaded] = useState<MirrorTask[]>([]);
  const gen = useRef(0);
  const given = tasks != null;

  useEffect(() => {
    setDraft("");
    setTaskId("");
  }, [session.id]);

  useEffect(() => {
    if (given) return;
    const folder = projectId?.trim() ?? "";
    const mine = ++gen.current;
    setLoaded([]);
    if (!folder) return;
    void invoke("tasks_list", { actor: { id: "person", project: folder, kind: "person" }, project: folder })
      .then((got) => {
        if (mine !== gen.current) return;
        setLoaded(asTasks(got));
      })
      .catch(() => {
        if (mine !== gen.current) return;
        setLoaded([]);
      });
  }, [given, projectId]);

  const choices = tasks ?? loaded;
  const ask = session.pendingPermission;

  return (
    <section aria-label={session.title || "Terminal"} className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex items-center justify-between gap-2 border-b border-stroke px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] text-content">{session.title || "Terminal"}</h2>
          <p className="text-[12px] text-content/60">
            {terminalStateLabel(session.state)} · {session.folder}
          </p>
        </div>
        <button type="button" className="text-[12px] text-content/70" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
        {session.blocks.map((block) => (
          <p key={block.id} className="whitespace-pre-wrap text-[13px] text-content">
            {block.text}
            {block.tool?.preview?.lines.map((line, index) => (
              <span key={`${block.id}-${index}`} className="block text-[12px] text-content/70">
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : ""}
                {line.text}
              </span>
            ))}
          </p>
        ))}
        <p className="text-[12px] text-content/60">Tool calls and diffs are read-only. A reply waits for the next turn.</p>
        {note ? <p className="text-[12px] text-content/70">{note}</p> : null}
      </div>
      <form
        className="flex flex-col gap-2 border-t border-stroke px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          onReply(text);
          setDraft("");
        }}
      >
        <input
          aria-label="Reply"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="rounded-md border border-stroke bg-transparent px-2 py-1 text-[13px] text-content"
        />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="text-[12px] text-content">
            Reply
          </button>
          <button type="button" className="text-[12px] text-content" onClick={onStop}>
            Stop
          </button>
          {ask ? (
            <>
              <button type="button" className="text-[12px] text-content" onClick={onAllow}>
                Allow
              </button>
              <button type="button" className="text-[12px] text-content" onClick={onDeny}>
                Deny
              </button>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[12px] text-content/70">
            Task
            <select
              aria-label="Task"
              className="ml-2 bg-transparent text-content"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">Choose a task</option>
              {choices.map((task) => (
                <option key={task.id} value={task.id}>
                  #{task.number} {task.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="text-[12px] text-content"
            onClick={() => {
              if (taskId) onAttach(taskId);
            }}
          >
            Attach to task
          </button>
        </div>
      </form>
    </section>
  );
}
