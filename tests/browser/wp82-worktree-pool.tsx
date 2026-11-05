import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  WorktreePool,
  type PoolSlotView,
} from "../../src/features/source-control/ui/WorktreePool";
import "../../src/styles/index.css";

const slots: PoolSlotView[] = [
  {
    path: "/Users/ash/Worktrees/pool/hivra-1",
    holder: "crew-a",
    state: "leased",
    bytes: 4096,
    branch: "mc/orch-aaaa",
  },
  {
    path: "/Users/ash/Worktrees/pool/hivra-2",
    state: "available",
    bytes: 2048,
    branch: "main",
  },
  {
    path: "/Users/ash/Worktrees/pool/hivra-3",
    holder: "crew-b",
    state: "dirty",
    bytes: 9000,
    reason: "Left in place: the worktree has uncommitted changes",
    branch: "mc/orch-bbbb",
  },
  {
    path: "/Users/ash/Worktrees/pool/hivra-4",
    state: "quarantined",
    reason: "The checkout looks damaged",
  },
];

function Page() {
  const [enabled, setEnabled] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [maxTrees, setMaxTrees] = useState(6);
  const [pruneLines, setPruneLines] = useState<string[]>();
  const [removed, setRemoved] = useState(false);
  return (
    <WorktreePool
      enabled={enabled}
      interactive={interactive}
      maxTrees={maxTrees}
      slots={removed ? slots.filter((slot) => slot.state !== "available") : slots}
      notice="The worktree pool isn't installed yet, so this checkout is a plain git worktree."
      pruneLines={pruneLines}
      onEnabled={setEnabled}
      onInteractive={setInteractive}
      onMaxTrees={setMaxTrees}
      onPrunePreview={() =>
        setPruneLines(["would remove /Users/ash/Worktrees/pool/hivra-2"])
      }
      onPruneConfirm={() => {
        setRemoved(true);
        setPruneLines(["Removed 1 idle worktree."]);
      }}
      onPruneCancel={() => setPruneLines(undefined)}
    />
  );
}

createRoot(document.getElementById("pool")!).render(<Page />);
