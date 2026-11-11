// Home renders a needs row's own actions. It does not invent a handler.
import type { NeedsItem } from "../../needs/model/needsYou";

export const HOME_ACTION_CAP = 3;

export function needActions(item: Pick<NeedsItem, "actions">): { label: string; title?: string; onClick: () => void }[] {
  return item.actions.slice(0, HOME_ACTION_CAP).map((action) => ({
    label: action.label,
    ...(action.ariaLabel || action.title ? { title: action.ariaLabel || action.title } : {}),
    onClick: () => action.run(),
  }));
}
