// Browser proof for the Installed list (WP-31): update, roll back and remove, with a faked Tauri bridge.
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

type Row = {
  name: string;
  version: string;
  source: { kind: string; location: string; pin?: string };
  installedAtMs: number;
  enabled: { global: boolean; projects: string[] };
  previous?: { version: string; source: { kind: string; location: string; pin?: string }; installedAtMs: number } | null;
};

const plugins: Record<string, Row> = {
  demo: {
    name: "demo",
    version: "1.0.0",
    source: { kind: "npm", location: "demo-plugin", pin: "1.0.0" },
    installedAtMs: 1,
    enabled: { global: true, projects: [] },
    previous: {
      version: "0.9.0",
      source: { kind: "npm", location: "demo-plugin", pin: "0.9.0" },
      installedAtMs: 0,
    },
  },
  solo: {
    name: "solo",
    version: "2.0.0",
    source: { kind: "local", location: "/tmp/solo" },
    installedAtMs: 2,
    enabled: { global: false, projects: [] },
  },
};

installFakeTauri("main", (command, args) => {
  if (command === "plugins_list") return { version: 1, plugins };
  if (command === "plugins_pending") return [];
  if (command === "plugins_rollback") {
    const row = plugins[String(args.name)];
    if (!row?.previous) throw "It has no earlier version.";
    row.version = row.previous.version;
    row.source = row.previous.source;
    row.previous = null;
    return { entry: row, reports: [] };
  }
  if (command === "plugins_uninstall") {
    delete plugins[String(args.name)];
    return { entry: null, reports: [] };
  }
  if (command === "plugins_update") {
    const source = args.source as { kind?: string; version?: string; package?: string };
    document.body.dataset.lastUpdate = JSON.stringify(source);
    const row = plugins[String(args.name)];
    if (row && source.kind === "npm" && source.version) {
      row.previous = { version: row.version, source: row.source, installedAtMs: row.installedAtMs };
      row.version = source.version;
      row.source = { kind: "npm", location: source.package || row.source.location, pin: source.version };
    }
    return { status: "installed", entry: row, reports: [] };
  }
  return null;
});

const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { InstalledPlugins } = await import("../../src/features/plugins/ui/InstalledPlugins");
createRoot(document.getElementById("root")!).render(
  createElement("div", { className: "text-content" }, createElement(InstalledPlugins)),
);
