// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Source: https://github.com/coollabsio/orbit
// Original path: apps/web/src/features/views/displayMeta.ts
// The upstream file has no file-level copyright line. See ../LICENSE.

import { Calendar, Kanban, List, type IconComponent } from './icons'
import type { GroupBy, Layout, TaskProperty } from './viewState'

/** Names and icons for display options, shared by the Display popover and the Views page. */
export const LAYOUTS: Array<{ value: Layout; label: string; icon: IconComponent }> = [
  { value: 'list', label: 'List', icon: List },
  { value: 'board', label: 'Board', icon: Kanban },
  { value: 'timeline', label: 'Timeline', icon: Calendar },
]

export const GROUP_LABEL: Record<GroupBy, string> = {
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  project: 'Project',
  label: 'Label',
  none: 'No grouping',
}

/** The properties a timeline row has room for; the others keep their value for list and board. */
export const TIMELINE_PROPERTIES: readonly TaskProperty[] = ['id', 'status', 'assignee', 'priority']
