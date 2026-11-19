/** Hub nav item for the one Agents board. */
export const AGENTS_ITEM = "agents";

/** The ready-made Agents page. A page Ash wrote that happens to share the title is left alone. */
export function isAgentsPage(page: { request?: string }): boolean {
  return page.request === "Ready-made: Agents";
}

/** In the Hub bundle the Agents page is this board, not its own tree. */
export function agentsPageUsesBoard(hubBundle: boolean): boolean {
  return hubBundle;
}

/** In the Hub bundle the sidebar does not draw the orchestration tree. */
export function sidebarShowsOrchestrationTree(hubBundle: boolean): boolean {
  return !hubBundle;
}
