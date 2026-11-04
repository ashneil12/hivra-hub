// Shapes the vendored Orbit helpers read.
// Rewritten because Orbit's models.ts imports generated API types (`@orbit/api/generated/types.gen`)
// and workspace members (`@/features/workspaces/models`) that Hivra does not build.
// Source: https://github.com/coollabsio/orbit (Apache-2.0), apps/web/src/features/tasks/api/models.ts.
// The upstream file has no file-level copyright line.

/** Only `id` and `name`. Orbit's User lives with workspace membership, which these helpers never read. */
export interface User {
  id: string;
  name: string;
}

export type StatusCategory = "unstarted" | "started" | "completed" | "cancelled" | "duplicate";
export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface TaskStatusDef {
  id: string;
  projectId: string;
  name: string;
  description: string;
  color: string;
  category: StatusCategory;
  position: number;
  version: number;
}

/** Another task as a relation needs it; the identifier is built from its project's key (`taskIdentifier`). */
export interface TaskRef {
  id: string;
  projectId: string;
  number?: number;
  title: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  url: string;
  /** An admin deleted the stored file. */
  deleted?: boolean;
}

export interface TaskComment {
  id: string;
  authorId: string;
  /** Markdown copy of `bodyJson`. */
  body: string;
  /** BlockNote blocks; null for a comment written before rich text (only `body` exists). */
  bodyJson?: unknown[] | null;
  /** Decided by the server for the current user. */
  canEdit: boolean;
  canDelete: boolean;
  createdAt: string;
  parentId?: string;
  attachments?: Attachment[];
  editedAt?: string | null;
  version: number;
}

/** One field an update changed. Ids stay ids: the feed names them (`activityChangeText`); projects are already names. */
export type TaskChange =
  | { field: "status"; from: string; to: string }
  | { field: "priority"; from: string; to: string }
  | { field: "assignees" | "labels"; added: string[]; removed: string[] }
  | { field: "due"; start: string | null; end: string | null }
  | { field: "title" | "project"; from: string; to: string }
  | { field: "description" | "source_url" };

export interface TaskActivity {
  id: string;
  actorId: string;
  actorName?: string;
  actorServiceAccountId?: string;
  text: string;
  /** The other task of a relation event; the feed links `identifier` inside `text`. */
  related?: { taskId: string; identifier: string };
  /** The changed field of a `task.updated` event; the feed shows its sentence instead of `text`. */
  change?: TaskChange;
  createdAt: string;
  statusId?: string;
}

/** A task named by id, title and project key: the "Parent title ›" label and the detail breadcrumb. */
export interface TaskKeyRef {
  id: string;
  title: string;
  projectKey: string;
  number?: number;
}

export interface Task {
  id: string;
  /** `ENG-12`: project key and number. */
  identifier: string;
  /** The number in the project; with `projectKey` it makes the identifier and the URL (`taskPath`). */
  number?: number;
  projectKey?: string;
  title: string;
  /** Markdown copy of `descriptionJson`. */
  description: string;
  /** BlockNote blocks; null for a task written before rich text (only `description` exists). */
  descriptionJson?: unknown[] | null;
  /** Epoch of the description's co-editing document. */
  collabEpoch?: string;
  sourceUrl?: string | null;
  statusId: string;
  position: number;
  priority: TaskPriority;
  assigneeIds: string[];
  creatorId?: string;
  creatorServiceAccountId?: string;
  creatorServiceAccountName?: string;
  projectId: string;
  labels: string[];
  attachments: Attachment[];
  dueStartAt?: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  comments: TaskComment[];
  activity: TaskActivity[];
  /** The canonical task while this task is marked as a duplicate. */
  duplicateOf?: TaskRef | null;
  /** At least one open task (not completed, cancelled or duplicate) blocks this one. */
  blocked?: boolean;
  /** Parent task id; null at the top level. */
  parentTaskId?: string | null;
  /** The parent, for the "Parent title ›" label. */
  parent?: TaskKeyRef | null;
  /** Direct live sub-issues. */
  subIssueCount?: number;
  /** Direct sub-issues that are completed or cancelled. */
  subIssueClosedCount?: number;
  /** Root first; only the detail endpoint sends it. */
  ancestors?: TaskKeyRef[];
  version: number;
}

export interface TaskViewState {
  currentUserId: string;
  users: User[];
  statuses: TaskStatusDef[];
  labels: import("./records").LabelRecord[];
  tasks: Task[];
}
