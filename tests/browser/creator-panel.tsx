// WP-34. Settings → Plugins mounts PluginsPage. This page mounts that same component and opens Creator.
// The draft comes from draftFor (no model). The panel document is the real sandbox srcdoc.
import { createRoot } from "react-dom/client";
import { PluginsPage } from "../../src/features/plugins/ui/DiscoverPage";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

type File = { path: string; content: string };

type Panel = { id: string; title: string; html: string; css: string; js: string; permissions: string[] };

type State = {
  id: string;
  view: string;
  revision: number;
  phase: string;
  plugin: string | null;
  expect: string;
  enabledGlobally: boolean;
  visibleHere: boolean;
  mcpApproved: boolean;
  mcpWaiting: boolean;
  scriptWaiting: boolean;
  reports: [];
  panel: Panel | null;
  skills: string[];
  mcpServers: string[];
  mcpTools: string[];
  mcpNote: string | null;
};

const params = new URLSearchParams(location.search);
const withServer = params.has("server");
const withScript = params.has("script");

let state: State | null = null;

function copy(): State {
  return JSON.parse(JSON.stringify(state)) as State;
}

function bump(patch: Partial<State>): State {
  state = { ...state!, ...patch, revision: state!.revision + 1 };
  return copy();
}

function panelFrom(files: File[]): Panel {
  const html = files.find((file) => file.path === "hivra/panels/hello/index.html")?.content ?? "";
  return { id: "hello", title: "Hello", html, css: "", js: "", permissions: [] };
}

function pluginName(files: File[]): string {
  const manifest = files.find((file) => file.path === "plugin.json");
  const name = manifest ? (JSON.parse(manifest.content) as { name?: string }).name : "";
  return typeof name === "string" ? name : "";
}

installFakeTauri("this-view", (command, args) => {
  if (command === "plugins_discover") return [];
  if (command === "creator_start") {
    document.body.dataset.creatorView = String(args.view ?? "");
    state = {
      id: "11111111-1111-4111-8111-111111111111",
      view: String(args.view ?? ""),
      revision: 1,
      phase: "started",
      plugin: null,
      expect: String(args.expect ?? ""),
      enabledGlobally: false,
      visibleHere: false,
      mcpApproved: false,
      mcpWaiting: false,
      scriptWaiting: false,
      reports: [],
      panel: null,
      skills: [],
      mcpServers: [],
      mcpTools: [],
      mcpNote: null,
    };
    return copy();
  }
  if (!state || args.revision !== state.revision) throw new Error("That draft is out of date. Read it again.");
  if (command === "creator_draft") {
    const files = Array.isArray(args.files) ? (args.files as File[]) : [];
    if (files.some((file) => file.path.includes("..") || file.path.includes("\\"))) {
      throw new Error("That path isn't inside the scratch folder.");
    }
    const name = pluginName(files);
    document.body.dataset.pluginName = name;
    return bump({
      phase: "drafted",
      plugin: name,
      panel: panelFrom(files),
      mcpWaiting: withServer,
      scriptWaiting: withScript,
      mcpServers: withServer ? ["ping"] : [],
    });
  }
  if (command === "creator_preview") {
    return bump({ phase: "previewed", visibleHere: true, enabledGlobally: false });
  }
  if (command === "creator_keep") {
    if (state.mcpWaiting || state.scriptWaiting) return copy();
    return bump({ phase: "kept", enabledGlobally: true });
  }
  if (command === "creator_undo") return bump({ phase: "undone", enabledGlobally: false });
  if (command === "creator_discard") {
    if (state.phase === "kept") throw new Error("Undo it first.");
    return bump({ phase: "discarded", panel: null });
  }
  if (command === "creator_approve_mcp") return bump({ mcpApproved: true, mcpWaiting: false });
  if (command === "creator_state") return copy();
  throw new Error(`unexpected ${command}`);
});

createRoot(document.getElementById("root")!).render(<PluginsPage />);
