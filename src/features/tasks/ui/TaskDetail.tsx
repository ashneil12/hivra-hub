// WP-70: one task. A status list is not a board.

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
  githubUrl?: string | null;
  githubPaused?: boolean;
  githubPulls?: readonly { title: string; url: string; state: string }[];
};

export function TaskDetail({
  task,
  note,
  onComment,
  onStatus,
  onAssign,
}: {
  task: TaskDetailTask;
  note?: string | null;
  onComment: (text: string) => void;
  onStatus?: (status: string) => void;
  onAssign?: (assignee: string) => void;
}) {
  return (
    <article aria-label={`Task ${task.number}`}>
      <h3 className="text-[13px] text-content">
        #{task.number} {task.title}
      </h3>
      <p className="mt-1 text-[12px] text-content/70">{task.status}</p>
      {task.needsYou ? <p className="text-[12px] text-content">Needs you</p> : null}
      {task.failed ? <p className="text-[12px] text-content">Failed</p> : null}
      {task.description ? <p className="mt-1 whitespace-pre-wrap text-[12px] text-content/80">{task.description}</p> : null}
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
      {note ? <p className="mt-1 text-[12px] text-content/70">{note}</p> : null}
      <label className="mt-2 block text-[12px] text-content/70">
        Status
        <select
          aria-label="Status"
          className="ml-2 bg-transparent text-content"
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
      <ul className="mt-2 space-y-1">
        {task.activity.map((entry) => (
          <li key={entry.id} className="text-[12px] text-content/70">
            {entry.text}
          </li>
        ))}
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
