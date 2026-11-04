// Which panel tabs are open (WP-33). A tab is not a workspace chat tab. Disabling a plugin drops it from the
// catalog, and a catalog that arrives late never puts a removed tab back.
import { validatePageSpec, type PageSpec } from "../../pages/model/pageSpec";

export type PanelOffer = { plugin: string; panelId: string };
export type PanelTab = { tabId: string; plugin: string; panelId: string };
export type PanelBoard = { rev: number; tabs: PanelTab[]; active?: string };

export type CatalogPanel = {
  plugin: string;
  panelId: string;
  title: string;
  spec: PageSpec;
};

const keyOf = (plugin: string, panelId: string) => `${plugin}\0${panelId}`;

/** One catalog row from the app, re-checked. A bad spec, a path and a duplicate are dropped. The first copy wins. */
export function readCatalog(raw: unknown): CatalogPanel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CatalogPanel[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const plugin = rec.plugin;
    const panelId = typeof rec.panelId === "string" ? rec.panelId : rec.id;
    if (typeof plugin !== "string" || plugin === "" || typeof panelId !== "string" || panelId === "") continue;
    if (/[\\/\0]|\.\./.test(plugin) || /[\\/\0]|\.\./.test(panelId)) continue;
    const checked = validatePageSpec(rec.spec);
    if (!checked.ok) continue;
    const key = keyOf(plugin, panelId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ plugin, panelId, title: checked.value.title, spec: checked.value });
  }
  return out;
}

/** Open a panel, or focus it when that plugin's panel is already open. An empty name does nothing. */
export function openTab(board: PanelBoard, offer: PanelOffer, tabId: string): PanelBoard {
  if (!offer.plugin || !offer.panelId || !tabId) return board;
  const existing = board.tabs.find((tab) => tab.plugin === offer.plugin && tab.panelId === offer.panelId);
  if (existing) return { ...board, active: existing.tabId };
  return { ...board, tabs: [...board.tabs, { tabId, plugin: offer.plugin, panelId: offer.panelId }], active: tabId };
}

/**
 * Apply a catalog. A revision older than the board's is ignored (a slow reply after a newer one). An equal
 * revision still applies, so a retry is not dropped. Tabs whose plugin and panel are gone are removed.
 */
export function applyCatalog(board: PanelBoard, rev: number, offers: readonly PanelOffer[]): PanelBoard {
  if (!Number.isFinite(rev) || rev < board.rev) return board;
  const keep = new Set(offers.map((offer) => keyOf(offer.plugin, offer.panelId)));
  const tabs = board.tabs.filter((tab) => keep.has(keyOf(tab.plugin, tab.panelId)));
  const active = tabs.some((tab) => tab.tabId === board.active) ? board.active : tabs[0]?.tabId;
  return { rev, tabs, active };
}
