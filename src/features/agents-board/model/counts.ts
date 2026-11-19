// Chip counts are the rows that are themselves in that state, under the current
// project filter. A row whose chip only repeats a child does not count. That is
// the same set as WP-210's needs and working counts: sessions, workers and
// sub-chats, not a parent rolled up from them.

import { filterBoard, settledToday } from "./filter";
import { flattenBoard, type BoardNode } from "./tree";

export type BoardChipCounts = {
  needsYou: number;
  working: number;
  doneToday: number;
};

export function boardChipCounts(root: BoardNode, projectId: string | null, now: number): BoardChipCounts {
  const shown = filterBoard(root, { projectId, state: null }, now);
  const counts: BoardChipCounts = { needsYou: 0, working: 0, doneToday: 0 };
  for (const node of flattenBoard(shown)) {
    if (node.rolledUp) continue;
    if (node.state === "needs-you") counts.needsYou += 1;
    else if (node.state === "working") counts.working += 1;
    else if (node.state === "done" && settledToday(node.settledAt, now)) counts.doneToday += 1;
  }
  return counts;
}
