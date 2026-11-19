// WP-101: the pending-install card shows what the install check found, and a clean plugin says so. Faked bridge.
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

const base = {
  op: "install",
  version: "1.0.0",
  source: { kind: "local", path: "/tmp/plugin" },
  resolved: { kind: "local", location: "/tmp/plugin" },
  requestedBy: { kind: "person" },
  steps: [],
  skills: ["count"],
  mcpServers: [],
  reports: [],
  createdAtMs: 1,
};

let pending: Record<string, unknown>[] = [
  {
    ...base,
    id: "11111111-1111-4111-8111-111111111111",
    name: "word-counter",
    scan: {
      blocked: false,
      files: 4,
      bytes: 900,
      tokenEstimate: 12,
      findings: [
        { severity: "info", code: "file_count", path: "", message: "It holds 4 files." },
        {
          severity: "warn",
          code: "scripts_present",
          path: "skills/count/scripts/run.py",
          message: "A script is copied with the plugin; Hivra never runs it.",
        },
      ],
    },
  },
  {
    ...base,
    id: "22222222-2222-4222-8222-222222222222",
    name: "plain-notes",
    createdAtMs: 2,
    scan: {
      blocked: false,
      files: 2,
      bytes: 100,
      tokenEstimate: 3,
      findings: [{ severity: "info", code: "file_count", path: "", message: "It holds 2 files." }],
    },
  },
];

installFakeTauri("main", (command, args) => {
  if (command === "plugins_pending") return pending;
  if (command === "plugins_approve" || command === "plugins_decline") {
    document.body.dataset.lastAnswer = JSON.stringify({ command, id: args.id });
    pending = pending.filter((request) => request.id !== args.id);
    return command === "plugins_approve" ? { status: "installed", entry: null, reports: [] } : null;
  }
  return null;
});

const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { PluginApprovals } = await import("../../src/features/plugins/ui/PluginApprovals");
createRoot(document.getElementById("root")!).render(
  createElement("div", { className: "text-content" }, createElement(PluginApprovals)),
);
