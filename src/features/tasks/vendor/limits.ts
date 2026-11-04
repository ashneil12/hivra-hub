// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original path: apps/web/src/features/tasks/api/tasks.ts
// The upstream file has no file-level copyright line. See ./LICENSE.
// Only the bulk-limit lines subIssuesLib uses. The rest of that file is Orbit's HTTP client.

export const MAX_BULK_TASK_UPDATES = 100;

export class BulkTaskLimitError extends Error {
  count: number;

  constructor(count: number) {
    super(`Bulk task operations accept at most ${MAX_BULK_TASK_UPDATES} updates; received ${count}.`);
    this.count = count;
  }
}
