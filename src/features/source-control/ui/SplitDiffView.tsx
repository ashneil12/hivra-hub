import { Component, type ReactNode, useEffect, useState } from "react";
import { splitFileText, type SplitFileText } from "../model/splitDiff";
import type { UnifiedDiffFileModel } from "../model/unifiedDiffDocument";
import { PierreFile } from "./pierreDiff";

// WP-116: optional split view. @pierre/diffs is a pinned package, not copied source.

type Props = {
  files: readonly UnifiedDiffFileModel[];
  fill: boolean;
};

function themeName(light: boolean): "github-light" | "github-dark" {
  return light ? "github-light" : "github-dark";
}

export function SplitDiffView({ files, fill }: Props) {
  const [light, setLight] = useState(() =>
    document.documentElement.classList.contains("theme-light"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const watch = new MutationObserver(() => {
      setLight(root.classList.contains("theme-light"));
    });
    watch.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => watch.disconnect();
  }, []);
  const theme = themeName(light);

  return (
    <div
      role="region"
      aria-label="Split diff"
      className={
        fill
          ? "min-h-0 flex-1 overflow-auto bg-transparent"
          : "min-w-0 overflow-x-auto"
      }
    >
      {files.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-content/45">No file changes</p>
      ) : (
        files.map((file) => {
          const text = splitFileText(file);
          if (!text) {
            return (
              <FileNote key={file.id} label={file.label}>
                {file.emptyMessage ??
                  (file.binary
                    ? "Binary file changed"
                    : file.tooLarge
                      ? "Diff is too large to display"
                      : "No textual diff")}
              </FileNote>
            );
          }
          return (
            <SplitBoundary key={file.id} label={text.name}>
              <PierreFile file={text} theme={theme} />
            </SplitBoundary>
          );
        })
      )}
    </div>
  );
}

function FileNote({ label, children }: { label: string; children: string }) {
  return (
    <div className="border-b border-stroke px-3 py-3">
      <p className="truncate text-[12px] text-content/70">{label}</p>
      <p className="mt-1 text-[13px] text-content/45">{children}</p>
    </div>
  );
}

class SplitBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <FileNote label={this.props.label}>
          Could not show this file side by side.
        </FileNote>
      );
    }
    return this.props.children;
  }
}

export type { SplitFileText };
