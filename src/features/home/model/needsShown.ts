// Home shows the first five needs. The count is the whole list (needsCount).

import { needsYou, type NeedsItem } from "../../needs/model/needsYou";

export const HOME_NEEDS_SHOWN = 5;

export function needsShown(items: readonly NeedsItem[], now: number): NeedsItem[] {
  return needsYou({ items }, now).slice(0, HOME_NEEDS_SHOWN);
}
