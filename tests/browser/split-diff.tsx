import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InboxPrDiff } from "../../src/features/inbox/ui/InboxPrDiff";
import { buildUnifiedFile } from "../../src/features/source-control/model/unifiedDiff";
import {
  applyThemePreference,
  saveThemePreference,
} from "../../src/features/settings/model/appearance";
import { ReviewDiff } from "../../src/features/source-control/ui/ReviewDiff";
import "../../src/styles/index.css";

saveThemePreference("dark");
applyThemePreference("dark");

// ?files=N   how many changed files the review has (default 1)
// ?focus=ID  a file to bring to the top, as the changes list does (for example file-4)
// ?pr=1      the review a pull request gets: a patch of hunks, with no full file text
const params = new URLSearchParams(location.search);
const count = Math.max(1, Number(params.get("files") ?? 1) || 1);
const focusId = params.get("focus") ?? undefined;
const stages: { id: string; pos?: number }[] = [];

function fileText(index: number): { original: string; current: string } {
  if (index > 0) {
    const lines = Array.from({ length: 60 }, (_, line) => `file ${index} line ${line}`);
    const changed = lines.slice();
    changed[30] = `file ${index} line 30 changed`;
    return { original: `${lines.join("\n")}\n`, current: `${changed.join("\n")}\n` };
  }
  return { original: "kept\nold line\n", current: "kept\nnew line\n" };
}

const prPatch = [
  "diff --git a/src/review/file.ts b/src/review/file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/review/file.ts",
  "+++ b/src/review/file.ts",
  "@@ -40,3 +40,3 @@ export function review() {",
  "   kept",
  "-  old line",
  "+  new line",
  "   kept",
  "",
].join("\n");

function Fixture() {
  const [files] = useState(() =>
    Array.from({ length: count }, (_, index) => {
      const { original, current } = fileText(index);
      const diff = buildUnifiedFile(original, current);
      return {
        id: `file-${index}`,
        path: `src/review/file-${index}.ts`,
        label: `src/review/file-${index}.ts`,
        additions: diff.additions,
        deletions: diff.deletions,
        blocks: diff.blocks,
        beforeText: original,
        afterText: current,
        canStageHunk: true,
      };
    }),
  );
  Object.assign(window, {
    splitStages: () => stages.slice(),
  });
  return (
    // Inline, not `h-screen`: Tailwind only scans src/, so that class is never generated here.
    <div style={{ height: "100vh" }}>
      {params.get("pr") ? (
        <InboxPrDiff
          diff={{
            additions: 1,
            deletions: 1,
            files: [{ path: "src/review/file.ts", additions: 1, deletions: 1 }],
            patch: prPatch,
            truncated: false,
          }}
        />
      ) : (
        <ReviewDiff
          files={files}
          focusId={focusId}
          onStageHunk={(id, pos) => {
            stages.push({ id, pos });
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
