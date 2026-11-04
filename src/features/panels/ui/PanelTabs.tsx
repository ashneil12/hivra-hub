// Plugin panels open as tabs (WP-33). Each one renders in the Pages sandbox and may call only what it asked for.
// Reads come from the app's local projects and delegations, not from Ash OS.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appPageSources } from "../../pages/model/pageSources";
import { pageCapabilityHandlers } from "../../pages/model/pageCapabilities";
import { allKeptPages } from "../../pages/model/pages";
import { MY_PANELS_ID, MY_PANELS_TITLE } from "../model/myPanels";
import { panelDocument, panelGrants, panelHost, SANDBOX } from "../model/panelSandbox";
import { applyCatalog, openTab, readCatalog, type CatalogPanel, type PanelBoard } from "../model/panelTabs";

export type { CatalogPanel };

function PanelFrame({ spec }: { spec: CatalogPanel["spec"] }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = ref.current;
    const win = frame?.contentWindow;
    if (!frame || !win) return;
    let handlers;
    let sources;
    try {
      handlers = pageCapabilityHandlers();
      sources = appPageSources(null);
    } catch {
      handlers = undefined;
      sources = undefined;
    }
    const host = panelHost(spec, (message) => win.postMessage(message, "*"), handlers, sources);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== win) return;
      host.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      host.dispose();
    };
  }, [spec]);
  return <iframe ref={ref} title={spec.title} sandbox={SANDBOX} srcDoc={panelDocument(spec)} className="h-40 w-full border-0" />;
}

export function PanelTabs({
  catalog,
  rev,
  onTurnOff,
}: {
  catalog: readonly CatalogPanel[];
  rev: number;
  onTurnOff?: (plugin: string) => void;
}) {
  const [board, setBoard] = useState<PanelBoard>({ rev: 0, tabs: [] });
  useEffect(() => {
    setBoard((prev) => applyCatalog(prev, rev, catalog.map((panel) => ({ plugin: panel.plugin, panelId: panel.panelId }))));
  }, [catalog, rev]);

  const plugins = [...new Set(catalog.map((panel) => panel.plugin))];
  if (!plugins.length && !board.tabs.length) return null;
  const byKey = new Map(catalog.map((panel) => [`${panel.plugin}\0${panel.panelId}`, panel]));

  return (
    <section data-panel-tabs className="flex shrink-0 flex-col gap-2 border-t border-stroke px-6 py-3">
      {plugins.map((plugin) => (
        <div key={plugin} data-panel-plugin-group={plugin}>
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] text-content">{plugin === MY_PANELS_ID ? MY_PANELS_TITLE : plugin}</h2>
            {onTurnOff ? (
              <button type="button" className="text-[12px] text-content/60" data-panel-turn-off={plugin} onClick={() => onTurnOff(plugin)}>
                Turn off
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {catalog.filter((panel) => panel.plugin === plugin).map((panel) => (
              <button
                key={panel.panelId}
                type="button"
                className="text-[13px] text-content"
                data-panel-open={`${panel.plugin}:${panel.panelId}`}
                onClick={() => setBoard((prev) => openTab(prev, { plugin: panel.plugin, panelId: panel.panelId }, `${panel.plugin}:${panel.panelId}`))}
              >
                Open {panel.title}
              </button>
            ))}
          </div>
        </div>
      ))}
      {board.tabs.map((tab) => {
        const panel = byKey.get(`${tab.plugin}\0${tab.panelId}`);
        if (!panel) return null;
        return (
          <article key={tab.tabId} data-panel-tab={tab.tabId} data-panel-plugin={tab.plugin} data-panel-grants={panelGrants(panel.spec).join(" ")}>
            <PanelFrame spec={panel.spec} />
          </article>
        );
      })}
    </section>
  );
}

/** The Pages screen's strip: migrate kept pages, then show whatever plugins are enabled. A late reply is ignored. */
export function PanelTabsScreen() {
  const gen = useRef(0);
  const alive = useRef(true);
  const [catalog, setCatalog] = useState<CatalogPanel[]>([]);
  const [rev, setRev] = useState(0);

  const load = async () => {
    const mine = ++gen.current;
    try {
      await invoke("panels_migrate", { pages: allKeptPages() });
    } catch {
      // A timeout or a missing command is not a final failure. The catalog is still read.
    }
    if (!alive.current || mine !== gen.current) return;
    try {
      const next = await invoke("panels_catalog");
      if (!alive.current || mine !== gen.current) return;
      setCatalog(readCatalog(next));
      setRev(mine);
    } catch {
      // Keep the tabs that are already open.
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  return (
    <PanelTabs
      catalog={catalog}
      rev={rev}
      onTurnOff={(plugin) => {
        const mine = ++gen.current;
        void invoke("plugins_disable", { name: plugin }).finally(() => {
          if (!alive.current || mine !== gen.current) return;
          void load();
        });
      }}
    />
  );
}
