// Browser-safe readers. Screens import this file, never the node git helpers.

export type TaskCommit = {
  sha: string;
  tier: "confirmed" | "inferred" | "person";
  agent: string | null;
  taskId: string | null;
  taskTitle: string | null;
  chatId: string | null;
  fileCount: number;
  lineCount: number;
  subject: string | null;
};

export type PrTask = { id: string; title: string };

export type PrCredit = { agents: string[]; tasks: PrTask[] };

const SHA = /^[0-9a-f]{7,64}$/;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return flat ? flat : null;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function tierOf(value: unknown): TaskCommit["tier"] | null {
  return value === "confirmed" || value === "inferred" || value === "person" ? value : null;
}

/** Drop a bad row. A person's commit never keeps a subject. */
export function readTaskCommits(value: unknown): TaskCommit[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TaskCommit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const sha = typeof row.sha === "string" ? row.sha : "";
    const tier = tierOf(row.tier);
    if (!tier || !SHA.test(sha) || seen.has(sha)) continue;
    seen.add(sha);
    const person = tier === "person";
    out.push({
      sha,
      tier,
      agent: person ? null : text(row.agent),
      taskId: person ? null : text(row.taskId),
      taskTitle: person ? null : text(row.taskTitle),
      chatId: person ? null : text(row.chatId),
      fileCount: count(row.fileCount),
      lineCount: count(row.lineCount),
      subject: person ? null : text(row.subject),
    });
  }
  return out;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function readPrCredit(value: unknown): PrCredit {
  if (!value || typeof value !== "object") return { agents: [], tasks: [] };
  const row = value as Record<string, unknown>;
  const agents = unique(
    (Array.isArray(row.agents) ? row.agents : []).flatMap((item) => {
      const name = text(item);
      return name ? [name] : [];
    }),
  );
  const seen = new Set<string>();
  const tasks: PrTask[] = [];
  for (const item of Array.isArray(row.tasks) ? row.tasks : []) {
    if (!item || typeof item !== "object") continue;
    const task = item as Record<string, unknown>;
    const id = text(task.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tasks.push({ id, title: text(task.title) ?? id });
  }
  return { agents, tasks };
}

export function countLine(files: number, lines: number): string {
  const fileWord = files === 1 ? "file" : "files";
  const lineWord = lines === 1 ? "line" : "lines";
  return `${files} ${fileWord}, ${lines} ${lineWord}`;
}
