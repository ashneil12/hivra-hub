// WP-70: one task. A status list is not a board. WP-71 adds the rest of the task, still in this panel.

import { appLink } from "../../stacks/model/link";
import { PRIORITY_LABEL, PRIORITY_ORDER } from "../vendor/taskMeta";
import type { TaskPriority } from "../vendor/models";
import { workingLabel } from "../model/working";
import { PhasePanel } from "../../phases/ui/PhasePanel";
import type { PathId } from "../../phases/model/settings";
import { MarkdownView } from "./MarkdownView";
import { TaskCommits } from "../../attribution/ui/TaskCommits";
import type { TaskCommit } from "../../attribution/read";

const STATUSES = ["Backlog", "Todo", "In progress", "In review", "Done", "Cancelled"] as const;

export type TaskDetailTask = {
  number: number;
  title: string;
  description: string;
  status: string;
  needsYou: boolean;
  failed: boolean;
  assignee: string | null;
  comments: readonly { id: string; body: string }[];
  activity: readonly { id: string; text: string }[];
  priority?: string;
  labels?: readonly string[];
  delegationId?: string | null;
  cli?: string | null;
  workingSince?: number | null;
  chatId?: string | null;
  dueAt?: number | null;
  githubUrl?: string | null;
  githubPaused?: boolean;
  githubPulls?: readonly { title: string; url: string; state: string }[];
};

export function TaskDetail({
  task,
  note,
  now = Date.now(),
  parentTitle,
  subtasks = [],
  onComment,
  onStatus,
  onPriority,
  onAssign,
  onOpenChat,
  commits = [],
  phase,
  onPhaseAnswer,
  onPhasePath,
  onPhaseDocComment,
  appUrl,
  ceiling = null,
}: {
  task: TaskDetailTask;
  /** WP-86: commits credited to this task. */
  commits?: readonly TaskCommit[];
  note?: string | null;
  now?: number;
  parentTitle?: string | null;
  subtasks?: readonly { number: number; title: string; status: string }[];
  onComment: (text: string) => void;
  onStatus?: (status: string) => void;
  onPriority?: (priority: string) => void;
  onAssign?: (assignee: string) => void;
  onOpenChat?: (chatId: string) => void;
  phase?: {
    pathLabel: string;
    why: string;
    pathId: PathId;
    documents: readonly { number: number; title: string; body: string }[];
    waiting: boolean;
  } | null;
  onPhaseAnswer?: (choice: string, words: string) => void;
  onPhasePath?: (path: string) => void;
  onPhaseDocComment?: (docNumber: number, text: string) => void;
  /** Local URL of this checkout's stack. Anything else is not shown. */
  appUrl?: string | null;
  /** WP-176: this project's per-task ceiling, and the reason a stopped run is held. */
  ceiling?: { line: string; held: string } | null;
}) {
  const followsWork = Boolean(task.delegationId);
  const held = ceiling?.held.trim() ?? "";
  const needsYou = task.needsYou || held.length > 0;
  const link = appLink(appUrl);
  const priority = (PRIORITY_ORDER as readonly string[]).includes(task.priority ?? "") ? task.priority ?? "none" : "none";
  return (
    <article aria-label={`Task ${task.number}`}>
      <h3 className="text-[13px] text-content">
        #{task.number} {task.title}
      </h3>
      <p className="mt-1 text-[12px] text-content/70">{task.status}</p>
      {needsYou ? <p className="text-[12px] text-content">Needs you</p> : null}
      {ceiling?.line ? (
        <p className="text-[12px] text-content/70" data-task-ceiling>
          {ceiling.line}
        </p>
      ) : null}
      {task.failed ? <p className="text-[12px] text-content">Failed</p> : null}
      {task.description ? <MarkdownView source={task.description} /> : null}
      {phase ? (
        <PhasePanel
          pathLabel={phase.pathLabel}
          why={phase.why}
          pathId={phase.pathId}
          documents={phase.documents}
          waiting={phase.waiting}
          onAnswer={onPhaseAnswer}
          onPath={onPhasePath}
          onDocComment={onPhaseDocComment}
        />
      ) : null}
      {task.githubUrl ? (
        <>
          <a href={task.githubUrl} className="mt-1 block text-[12px] text-content">
            {task.githubUrl}
          </a>
          <p className="mt-1 text-[12px] text-content/70">
            This task's title and description are read-only while it is linked to GitHub.
          </p>
        </>
      ) : null}
      {task.githubPaused ? (
        <>
          <p className="mt-1 text-[12px] text-content">GitHub sync paused</p>
          <p className="text-[12px] text-content/70">
            Add the project label to the GitHub issue or pull request again to resume updates.
          </p>
        </>
      ) : null}
      {(task.githubPulls ?? []).some((pull) => pull.url !== task.githubUrl) ? (
        <section aria-label="GitHub links" className="mt-2">
          {(task.githubPulls ?? [])
            .filter((pull) => pull.url !== task.githubUrl)
            .map((pull) => (
              <a key={pull.url} href={pull.url} className="block text-[12px] text-content">
                {pull.title || pull.url}
              </a>
            ))}
        </section>
      ) : null}
      <p className="mt-1 text-[12px] text-content/70">{task.assignee ? `Assigned to ${task.assignee}` : "Unassigned"}</p>
      {parentTitle ? <p className="text-[12px] text-content/70">Parent {parentTitle}</p> : null}
      {task.labels && task.labels.length > 0 ? <p className="text-[12px] text-content/70">{task.labels.join(", ")}</p> : null}
      {typeof task.dueAt === "number" ? <p className="text-[12px] text-content/70">Due {new Date(task.dueAt).toISOString().slice(0, 10)}</p> : null}
      {task.cli ? <p className="text-[12px] text-content/70">{task.cli}</p> : null}
      {typeof task.workingSince === "number" ? <p className="text-[12px] text-content/70">{workingLabel(task.workingSince, now)}</p> : null}
      {followsWork ? <p className="text-[12px] text-content/70">This task follows its work.</p> : null}
      {note ? <p className="mt-1 text-[12px] text-content/70">{note}</p> : null}
      <TaskCommits commits={commits} />
      <label className="mt-2 block text-[12px] text-content/70">
        Status
        <select
          aria-label="Status"
          className="ml-2 bg-transparent text-content"
          disabled={followsWork}
          value={STATUSES.includes(task.status as (typeof STATUSES)[number]) ? task.status : ""}
          onChange={(event) => onStatus?.(event.target.value)}
        >
          {STATUSES.includes(task.status as (typeof STATUSES)[number]) ? null : <option value="">{task.status}</option>}
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      {onPriority ? (
        <label className="mt-2 block text-[12px] text-content/70">
          Priority
          <select aria-label="Priority" className="ml-2 bg-transparent text-content" value={priority} onChange={(event) => onPriority(event.target.value)}>
            {PRIORITY_ORDER.map((item) => (
              <option key={item} value={item}>
                {PRIORITY_LABEL[item as TaskPriority]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {subtasks.length > 0 ? (
        <ul className="mt-2">
          {subtasks.map((subtask) => (
            <li key={`${subtask.number}-${subtask.title}`} className="text-[12px] text-content/70">
              #{subtask.number} {subtask.title}
            </li>
          ))}
        </ul>
      ) : null}
      {link ? (
        <a
          className="mt-1 inline-block text-[12px] text-content"
          href={link}
          onClick={(event) => {
            if (!("__TAURI_INTERNALS__" in window)) return;
            event.preventDefault();
            void import("@tauri-apps/plugin-opener")
              .then((mod) => mod.openUrl(link))
              .catch(() => undefined);
          }}
        >
          Open the running app
        </a>
      ) : null}
      {task.chatId && onOpenChat ? (
        <button type="button" className="mt-2 text-[12px] text-content/80" onClick={() => onOpenChat(task.chatId ?? "")}>
          Open chat
        </button>
      ) : null}
      <ul className="mt-2 space-y-1">
        {task.activity.map((entry) => (
          <li key={entry.id} className="text-[12px] text-content/70">
            {entry.text}
          </li>
        ))}
        {held && !task.activity.some((entry) => entry.text === held) ? (
          <li className="text-[12px] text-content/70">{held}</li>
        ) : null}
        {task.comments.map((comment) => (
          <li key={comment.id} className="text-[12px] text-content">
            {comment.body}
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const text = String(data.get("comment") ?? "");
          if (!text.trim()) return;
          onComment(text);
          event.currentTarget.reset();
        }}
      >
        <input
          name="comment"
          aria-label="Comment"
          className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
        />
        <button type="submit" className="text-[12px] text-content/70">
          Add comment
        </button>
      </form>
      {onAssign ? (
        <form
          className="mt-1.5 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            onAssign(String(data.get("assignee") ?? "").trim());
          }}
        >
          <input
            name="assignee"
            aria-label="Assignee"
            defaultValue={task.assignee ?? ""}
            className="min-w-0 flex-1 rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content"
          />
          <button type="submit" className="text-[12px] text-content/70">
            Assign
          </button>
        </form>
      ) : null}
    </article>
  );
}
