// WP-34. The Creator screen against a fake bridge. The panel document is the real sandbox srcdoc.
// A path that leaves the scratch folder is refused. The paragraph outside #root stands in for Hivra's own code.

import { createRoot } from "react-dom/client";
import { CreatorScreen } from "../../src/features/creator/ui/CreatorScreen";
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

installFakeTauri("creator", (command, args) => {
  if (command === "creator_start") {
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
    return bump({
      phase: "drafted",
      plugin: "made-panel",
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
  if (command === "creator_discard") return bump({ phase: "discarded", panel: null });
  if (command === "creator_approve_mcp") return bump({ mcpApproved: true, mcpWaiting: false });
  if (command === "creator_state") return copy();
  throw new Error(`unexpected ${command}`);
});

createRoot(document.getElementById("root")!).render(<CreatorScreen />);
