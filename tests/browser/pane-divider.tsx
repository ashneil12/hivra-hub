import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PaneTree } from "../../src/features/workspace/ui/PaneTree";
import {
  MIN_SIZE,
  leafIds,
  setSplitRatio,
  type EditorPane,
  type LayoutNode,
  type SplitDir,
} from "../../src/features/workspace/model/layout";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

// The real PaneTree with file panes and no native IPC. The specs measure
// committed ratios and the header buttons, so slides are switched off
// before the tree mounts.

type Scenario = "pair" | "row" | "stack" | "single" | "full";

type PaneEvent =
  | { kind: "focus"; paneId: string; reason?: string }
  | { kind: "split"; dir: SplitDir };

// A same-direction split is refused once the next equal share would be
// smaller than the minimum pane size. This is that fullest group.
function fullestGroup(): number {
  let count = 1;
  while (1 / (count + 1) >= MIN_SIZE) count += 1;
  return count;
}

const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") ?? "pair") as Scenario;
const start = Number(params.get("start") ?? "0.5");

const root = document.documentElement;
root.classList.add("glass-body");
root.style.setProperty("--theme-hue", "240");
root.style.setProperty("--theme-saturation", "0%");
root.style.setProperty("--theme-dark-lightness", "9%");

const motion = window.matchMedia.bind(window);
window.matchMedia = (query: string): MediaQueryList =>
  query.includes("prefers-reduced-motion")
    ? ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList)
    : motion(query);

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "control_load") return null;
      if (command === "session_checkpoint_status") return { files: [] };
      if (command === "list_project_files") return [];
      return null;
    },
  },
});

function leaf(id: string): LayoutNode {
  return { type: "leaf", id };
}

function split(dir: SplitDir, sizes: number[], ids: string[]): LayoutNode {
  return {
    type: "split",
    id: `split-${dir}`,
    dir,
    children: ids.map(leaf),
    sizes,
  };
}

function initial(): LayoutNode {
  if (scenario === "single") return leaf("a");
  if (scenario === "stack") return split("down", [start, 1 - start], ["a", "b"]);
  if (scenario === "row") return split("right", [0.2, 0.3, 0.5], ["a", "b", "c"]);
  if (scenario === "full") {
    const count = fullestGroup();
    const ids = Array.from({ length: count }, (_, index) =>
      index === 0 ? "a" : `p${index}`,
    );
    return split(
      "right",
      ids.map(() => 1 / count),
      ids,
    );
  }
  return split("right", [start, 1 - start], ["a", "b"]);
}

const starting = initial();

const panes: EditorPane[] = leafIds(starting).map((id) => ({
  id,
  files: [],
  activeFileId: "",
}));

const noop = () => {};
const paneEvents: PaneEvent[] = [];

function Fixture() {
  const [layout, setLayout] = useState<LayoutNode>(initial);
  const [ratios, setRatios] = useState<
    { splitId: string; index: number; ratio: number }[]
  >([]);
  Object.assign(window, {
    paneTreeRatios: ratios,
    paneTreeSizes: () => (layout.type === "split" ? layout.sizes : [1]),
    paneTreeEvents: paneEvents,
  });
  return (
    <div data-pane-fixture="" style={{ height: 600, width: 800 }}>
      <PaneTree
        visible
        layout={layout}
        sessions={[]}
        editorPanes={panes}
        dirtyFileIds={new Set()}
        fileErrorCounts={new Map()}
        focusedId="a"
        composerFocused={false}
        recents={[]}
        onFocus={(paneId, reason?: "pointer") => {
          paneEvents.push({ kind: "focus", paneId, reason });
        }}
        onSplit={(dir) => {
          paneEvents.push({ kind: "split", dir });
        }}
        onClose={noop}
        onSelectFile={noop}
        onCloseFile={noop}
        onCloseOtherFiles={noop}
        onReorderFiles={noop}
        onFileDirtyChange={noop}
        onFileErrorCountChange={noop}
        onRatio={(splitId, index, ratio) => {
          setRatios((prev) => [...prev, { splitId, index, ratio }]);
          setLayout((prev) => setSplitRatio(prev, splitId, index, ratio));
        }}
        onCwdChange={noop}
        onBranchChange={noop}
        onModelChange={noop}
        onModelSettingsChange={noop}
        onRuntimeModeChange={noop}
        onSubmit={noop}
        onStop={noop}
        onCompactContext={() => false}
        onPlaceSessionInFolder={noop}
        onDeleteQueuedMessage={noop}
        onEditQueuedMessage={noop}
        onQueuedMessageEditingChange={noop}
        onSteerQueuedMessage={noop}
        onResumeQueue={noop}
        onApproval={noop}
        onQuestionReply={noop}
        onOpenFile={noop}
        onOpenDiff={noop}
        onOpenPlan={noop}
        onUpdatePlan={noop}
        onBuildPlan={noop}
        onMovePane={noop}
        onDetachPane={noop}
        onNewTerminal={noop}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
