// One trash for every kind. The clock and the batch rules live in src-tauri/src/trash.rs.

export const TRASH_KINDS = ["chat", "mono", "project", "note", "doc", "task"] as const;

export type TrashKind = (typeof TRASH_KINDS)[number];

export const RETENTION_DAYS = 30;

export const RUNNING_CHAT =
  "This chat is still running. Stop it, then move it to the trash.";

export const TRASH_CHANGED = "monocode:trash";

export type TrashListItem = {
  kind: string;
  id: string;
  title: string;
  deletedAt: number;
  version: number;
  withCount: number;
  payload: string;
};

export type RestoredItem = {
  kind: string;
  id: string;
  title: string;
  payload: string;
  detached: boolean;
};

const KIND_LABEL: Record<TrashKind, string> = {
  chat: "Chats",
  mono: "Monos",
  project: "Projects",
  note: "Notes",
  doc: "Docs",
  task: "Tasks",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as TrashKind] ?? "Other";
}

/** How many other things went with this one. Nothing, when it was trashed on its own. */
export function withItLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1 ? "+ 1 with it" : `+ ${Math.floor(count)} with it`;
}

export function groupTrash(items: readonly TrashListItem[]): { kind: string; label: string; items: TrashListItem[] }[] {
  const groups: { kind: string; label: string; items: TrashListItem[] }[] = [];
  for (const kind of TRASH_KINDS) {
    const rows = items.filter((item) => item.kind === kind);
    if (rows.length > 0) groups.push({ kind, label: kindLabel(kind), items: rows });
  }
  const known = new Set<string>(TRASH_KINDS);
  const other = items.filter((item) => !known.has(item.kind));
  if (other.length > 0) groups.push({ kind: "other", label: "Other", items: other });
  return groups;
}

/** A payload from disk is untrusted. A bad one is ignored, not thrown. */
export function readPayload(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
