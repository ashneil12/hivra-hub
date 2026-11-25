// G10: the Inbox's one list. A first mate's decision is one Needs you row, never a row and a second card.
import type { FirstMateItem } from "../../crew/model/inbox";
import { foldDecisionKey } from "../../hub/model/decisionKey";
import type { NeedsItem } from "./needsYou";

export type InboxRow = { key: string; need: NeedsItem | null; decision: FirstMateItem | null };

/**
 * Each Needs you row, carrying the first mate's decision it names: the same decision key (or the gate key of a parked
 * one, in any spelling) in the same project. A decision no row names yet (the two reads land at different moments, or
 * it has no words a row can show) is added at the end, so it never drops out of the Inbox.
 *
 * A decision he let go (`letGo`, settledNeeds.ts `letGoDecisionKeys`) draws no row, even though the decision store
 * still has it open: his own drop is final (Ash, 13 Nov: "there's a lot of ones that I can't actually tick as done").
 */
export function foldFirstMate(
  needs: readonly NeedsItem[],
  decisions: readonly FirstMateItem[],
  projectOf: (path: string) => string | undefined,
  letGo?: ReadonlySet<string>,
): InboxRow[] {
  const left = decisions.filter(
    (item) => item.kind === "decision" && item.key?.trim() && !letGo?.has(foldDecisionKey(item.key)),
  );
  const rows = needs.map((need): InboxRow | null => {
    const named = need.decisionKey?.trim() || need.gateKey?.trim();
    // The row a decision drew leaves with the decision he let go, even though the decision store still has it open.
    if (named && letGo?.has(foldDecisionKey(named))) return null;
    if (!named) return { key: need.key, need, decision: null };
    const folded = foldDecisionKey(named);
    const at = left.findIndex(
      (item) => foldDecisionKey(item.key ?? "") === folded && projectOf(item.project) === need.projectId,
    );
    if (at < 0) return { key: need.key, need, decision: null };
    const [decision] = left.splice(at, 1);
    return { key: need.key, need, decision: decision ?? null };
  });
  return [
    ...rows.filter((row): row is InboxRow => row !== null),
    ...left.map((decision): InboxRow => ({ key: decision.id, need: null, decision })),
  ];
}
