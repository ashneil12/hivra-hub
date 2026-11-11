// WP-219: in the Hub bundle the sidebar does not draw its own agent tree. It opens the board.

import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { showAppItem } from "../../hub/model/hubNav";
import { OrchestrationSidebarAgents } from "../../orchestration/ui/OrchestrationSidebarAgents";
import type { OrchestrationSummary } from "../../orchestration/model/orchestrationSummary";
import { AGENTS_ITEM, sidebarShowsOrchestrationTree } from "../model/place";

export function SidebarAgents(props: {
  leadId: string;
  summary: OrchestrationSummary;
  variant?: "card" | "tree";
}) {
  if (sidebarShowsOrchestrationTree(IS_HUB_BUNDLE)) return <OrchestrationSidebarAgents {...props} />;
  return (
    <button
      type="button"
      data-agents-board-link
      className="mx-2 mb-1 rounded-md px-2 py-1 text-left text-[12px] text-content/70 hover:bg-content/10"
      onClick={() => showAppItem(AGENTS_ITEM)}
    >
      Agents
    </button>
  );
}
