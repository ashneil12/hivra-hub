import type { NeedsItem } from "../../features/needs/model/needsYou";

export type PanelAsk = {
  id: string;
  sentence: string;
  actions: { label: string; run: () => void }[];
};

/**
 * Questions and approvals the red number counts that are not already a stopped worker row.
 * The panel lists these beside the workers, so its rows match the number.
 */
export function monoPanelAsks(
  items: readonly NeedsItem[],
  monoId: string | undefined,
  shown?: ReadonlySet<string>,
): PanelAsk[] {
  return items.filter((item) => {
    if (item.kind === "stopped" || !item.monoId) return false;
    if (monoId) return item.monoId === monoId;
    return shown?.has(item.monoId) === true;
  }).map((item) => ({ id: item.key, sentence: item.sentence, actions: [...item.actions] }));
}
