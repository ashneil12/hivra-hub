// Shapes Orbit's generated API types give the vendored helpers.
// Rewritten because `@orbit/api/generated/types.gen` is generated server code Hivra does not build.
// Source: https://github.com/coollabsio/orbit (Apache-2.0). The upstream files have no file-level copyright line.

export interface LabelRecord {
  id: string;
  name: string;
  color: string;
  version: number;
  workspace_id: string;
  project_id: string;
}

export interface BulkItem {
  id: string;
  expected_version: number;
  status_id?: string;
  priority?: string;
  assignee_ids?: string[];
  label_ids?: string[];
  due_start_at?: string | null;
  due_at?: string | null;
}

export interface CreateTaskBody {
  title?: string;
  project_id: string;
  status_id: string;
  priority: string;
  assignee_ids: string[];
  parent_task_id: string;
}

export interface TaskRelationRecord {
  id: string;
  type: string;
  direction: string;
  created_at: string;
  task: {
    id: string;
    project_id?: string;
    title?: string;
    status_id?: string;
    version?: number;
  };
}
