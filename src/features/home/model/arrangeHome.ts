// Moving a Home section skips Projects. That built-in stays in the saved order, and it is never shown.

import { moveSection, type HomeArrangement } from "./arrangement";

export function moveHomeSection(arr: HomeArrangement, key: string, dir: -1 | 1): HomeArrangement {
  if (key === "projects") return arr;
  const hidden = arr.hidden.includes("projects") ? arr.hidden : [...arr.hidden, "projects"];
  const moved = moveSection({ ...arr, hidden }, key, dir);
  return { ...moved, hidden: arr.hidden };
}
