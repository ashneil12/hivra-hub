import { useMemo, useState } from "react";
import type { GithubPrDiff } from "../model/githubTasks";
import { mergePrDiff, parsePrPatch, type PrDiffFile } from "../../source-control/model/prDiff";
import { blocksFromLines, type UnifiedLine } from "../../source-control/model/unifiedDiff";
import { type UnifiedDiffFileModel } from "../../source-control/ui/UnifiedDiffView";
import { ReviewDiff } from "../../source-control/ui/ReviewDiff";
import { InboxPrGuide, type InboxPrGuideProps } from "./InboxPrGuide";

type Props = {
  diff: GithubPrDiff;
  /** When true, show the whole file (no fold rows). */
  fullFile?: boolean;
  /** File to open and scroll to, such as one picked from the summary. */
  focusPath?: string;
  /** A line to bring into view, such as a review guide's stop. */
  focusLine?: { path: string; line: number; seq: number };
};

type CodeProps = Props & {
  /** Remounts the diff (a refresh or a new context mode) without losing the guide. */
  diffKey: string;
  /** A GitHub pull request's review guide (WP-132). Absent for other hosts. */
  guide?: Omit<InboxPrGuideProps, "diff" | "onOpen">;
};

/** A pull request's Code tab: the review guide, when there is one, above the diff its stops jump into. */
export function InboxPrCode({ diff, diffKey, fullFile, focusPath, guide }: CodeProps) {
  const [jump, setJump] = useState<{ path: string; line: number; seq: number }>();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {guide ? (
        <InboxPrGuide
          {...guide}
          diff={diff}
          onOpen={(path, line) => setJump((current) => ({ path, line, seq: (current?.seq ?? 0) + 1 }))}
        />
      ) : null}
      <InboxPrDiff key={diffKey} diff={diff} fullFile={fullFile} focusPath={focusPath} focusLine={jump} />
    </div>
  );
}

export function InboxPrDiff({ diff, fullFile = false, focusPath, focusLine }: Props) {
  const files = useMemo(() => {
    const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
    const context = fullFile ? Number.POSITIVE_INFINITY : undefined;
    return parsed.map((file) => toModel(file, diff.truncated, context));
  }, [diff, fullFile]);

  return (
    <ReviewDiff
      files={files}
      truncated={diff.truncated}
      totals={{ additions: diff.additions, deletions: diff.deletions }}
      fill={false}
      fileLayout="cards"
      initialExpansion="first"
      focusPath={focusPath}
      focusLine={focusLine}
    />
  );
}

function toModel(
  file: PrDiffFile,
  truncated: boolean,
  context?: number,
): UnifiedDiffFileModel {
  const lines = file.lines.map(toUnifiedLine);
  return {
    id: file.path,
    path: file.path,
    label:
      file.status === "renamed" && file.previousPath
        ? `${file.previousPath} → ${file.path}`
        : file.path,
    binary: file.binary,
    emptyMessage:
      !file.binary && file.lines.length === 0
        ? truncated
          ? "Patch unavailable because this change is too large"
          : "No textual diff"
        : undefined,
    additions: file.additions,
    deletions: file.deletions,
    blocks: blocksFromLines(lines, context),
  };
}

function toUnifiedLine(line: PrDiffFile["lines"][number]): UnifiedLine {
  return {
    kind: line.kind,
    text: line.text,
    oldNumber: line.oldNumber,
    newNumber: line.newNumber,
  };
}
