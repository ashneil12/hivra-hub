// One line per project that has a worker still running. The count is workingCount (WP-210).

export type WorkingRow = {
  id: string;
  project: string | null;
  title: string | null;
  goal: string | null;
  state: string;
  createdAt: number;
};

export type WorkingLine = {
  key: string;
  projectId: string;
  text: string;
  since: string;
  count: number;
  at: number;
};

/** 24-hour clock, local to the machine. An unreadable time is blank, not a guess. */
export function sinceClock(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `since ${hours}:${minutes}`;
}

function titleOf(row: WorkingRow): string {
  const title = (row.title ?? "").trim() || (row.goal ?? "").trim();
  return title || "untitled work";
}

/**
 * Running rows only, grouped by project. Question, failed and cancelled rows are not working.
 * The words never include a row id.
 */
export function workingLines(rows: readonly WorkingRow[]): WorkingLine[] {
  const groups = new Map<string, WorkingRow[]>();
  for (const row of rows) {
    if (row.state !== "running" || typeof row.id !== "string" || !row.id) continue;
    const projectId = (row.project ?? "").trim();
    const list = groups.get(projectId);
    if (list) list.push(row);
    else groups.set(projectId, [row]);
  }
  const lines: WorkingLine[] = [];
  for (const [projectId, list] of groups) {
    const at = list.reduce((earliest, row) => Math.min(earliest, row.createdAt), Number.POSITIVE_INFINITY);
    const count = list.length;
    const noun = count === 1 ? "worker" : "workers";
    lines.push({
      key: projectId || "none",
      projectId,
      count,
      at: Number.isFinite(at) ? at : 0,
      since: sinceClock(at),
      text: `${count} ${noun}: ${list.map(titleOf).join(", ")}`,
    });
  }
  return lines.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function workersLabel(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${n} ${n === 1 ? "worker" : "workers"}`;
}
