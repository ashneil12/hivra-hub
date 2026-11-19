// PT-2: Settings > Crew > "Proof tools", with the app's answers stubbed. The stub keeps one record per project in the page, like the
// app's offers file (which tools are off and the revision a write must be based on), and records each call so the spec can read what
// the control asked it to write.
//   ?home=1   Home is in view: a project picker comes first.
//   ?stale=1  Another window switches Playwright off just before the first write, so that write is refused.
//   ?none=1   Nothing in the catalogue fits /work/app.
import { createRoot } from "react-dom/client";
import { findProofTool } from "../../src/features/proofTools/model/proofTools";
import { ProofToolsSetting } from "../../src/features/proofTools/ui/ProofToolsSetting";
import "../../src/styles/index.css";

const STALE = "That changed in another window. Look again, then set it.";

type Fit = { id: string; installed: boolean; status?: "open" | "proposed" | "declined" };
type Project = { fits: Fit[]; off: Set<string>; revision: number };

const params = new URLSearchParams(window.location.search);
const calls: { command: string; args: unknown }[] = [];
let staleOnce = params.has("stale");

// In the catalogue's order, as the app lists them.
const projects = new Map<string, Project>([
  [
    "/work/app",
    {
      fits: params.has("none")
        ? []
        : [
            { id: "fast-check", installed: true },
            { id: "stryker", installed: false, status: "proposed" },
            { id: "semgrep", installed: false, status: "declined" },
            { id: "playwright", installed: true },
          ],
      off: new Set(),
      revision: 0,
    },
  ],
  ["/work/other", { fits: [{ id: "proptest", installed: true }], off: new Set(), revision: 0 }],
]);

function wire(project: Project) {
  return {
    stacks: ["node", "web"],
    revision: project.revision,
    tools: project.fits.map((fit) => {
      const known = findProofTool(fit.id)!;
      return {
        id: fit.id,
        name: known.name,
        proves: known.proves,
        howToUse: known.howToUse,
        kind: known.kind,
        external: known.external,
        installed: fit.installed,
        status: fit.status ?? "open",
        off: fit.installed && project.off.has(fit.id),
      };
    }),
  };
}

Object.assign(window, {
  __proofToolsCalls: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args?: unknown) => {
      if (command === "plugin:event|listen") return 0;
      calls.push({ command, args });
      if (command === "plugin:opener|open_url") return null;
      const { folder, toolId, on, expectedRevision } = (args ?? {}) as {
        folder: string;
        toolId?: string;
        on?: boolean;
        expectedRevision?: number;
      };
      const project = projects.get(folder) ?? { fits: [], off: new Set<string>(), revision: 0 };
      if (command === "proof_tools_list") return wire(project);
      if (command === "proof_tools_set") {
        if (staleOnce) {
          staleOnce = false;
          project.off.add("playwright");
          project.revision = 9;
          throw STALE;
        }
        if (expectedRevision !== project.revision) throw STALE;
        if (on) project.off.delete(toolId!);
        else project.off.add(toolId!);
        project.revision += 1;
        return { off: [...project.off], revision: project.revision };
      }
      return null;
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <div className="max-w-xl p-6 text-content">
    <ProofToolsSetting
      project="/work/app"
      recents={[{ path: "/work/other" }, { path: "/work/app" }]}
      home={params.has("home")}
    />
  </div>,
);
