// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original path: packages/api/src/generated/types.gen.ts
// The upstream file has no file-level copyright line. See ./LICENSE.
// Shapes Orbit's generated API types give the vendored helpers.
// Rewritten because `@orbit/api/generated/types.gen` is generated server code Hivra does not build.

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
