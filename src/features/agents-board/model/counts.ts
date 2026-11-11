// Chip counts are the rows on this board, under the current project filter.
// When PR #243 lands, a row's state comes from that needs list, and these
// counts follow because they count the rows. They do not read a second list.

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
    if (node.state === "needs-you") counts.needsYou += 1;
    else if (node.state === "working") counts.working += 1;
    else if (node.state === "done" && settledToday(node.settledAt, now)) counts.doneToday += 1;
  }
  return counts;
}
