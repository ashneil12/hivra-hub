import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { SplitFileText } from "../model/splitDiff";

// WP-116: the only import of the pinned @pierre/diffs package.

type Props = {
  file: SplitFileText;
  theme: "github-light" | "github-dark";
};

/**
 * Shiki names, not Pierre's own product theme. A pair plus themeType, because
 * the viewer paints inside a shadow root that would otherwise follow the OS.
 */
const THEMES = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

export function PierreFile({ file, theme }: Props) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: file.name, contents: file.before },
        { name: file.name, contents: file.after },
      ),
    [file.name, file.before, file.after],
  );
  const options = useMemo(
    () => ({
      diffStyle: "split" as const,
      theme: THEMES,
      themeType: theme === "github-light" ? ("light" as const) : ("dark" as const),
      disableFileHeader: true,
    }),
    [theme],
  );
  return <FileDiff fileDiff={fileDiff} options={options} />;
}
