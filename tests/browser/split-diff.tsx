import { useState } from "react";
import { createRoot } from "react-dom/client";
import { buildUnifiedFile } from "../../src/features/source-control/model/unifiedDiff";
import {
  applyThemePreference,
  saveThemePreference,
} from "../../src/features/settings/model/appearance";
import { ReviewDiff } from "../../src/features/source-control/ui/ReviewDiff";
import "../../src/styles/index.css";

saveThemePreference("dark");
applyThemePreference("dark");

const original = "kept\nold line\n";
const current = "kept\nnew line\n";
const diff = buildUnifiedFile(original, current);
const stages: { id: string; pos?: number }[] = [];

function Fixture() {
  const [files] = useState(() => [
    {
      id: "file-0",
      path: "src/review/file.ts",
      label: "src/review/file.ts",
      additions: diff.additions,
      deletions: diff.deletions,
      blocks: diff.blocks,
      beforeText: original,
      afterText: current,
      canStageHunk: true,
    },
  ]);
  Object.assign(window, {
    splitStages: () => stages.slice(),
  });
  return (
    <div className="h-screen">
      <ReviewDiff
        files={files}
        onStageHunk={(id, pos) => {
          stages.push({ id, pos });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
