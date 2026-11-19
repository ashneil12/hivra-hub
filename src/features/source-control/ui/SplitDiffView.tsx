import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  splitFileText,
  splitFocusId,
  type SplitFileText,
} from "../model/splitDiff";
import type { UnifiedDiffFileModel } from "../model/unifiedDiffDocument";
import type { PierreFileComponent, SplitTheme } from "./splitPackage";

// WP-116: optional split view. @pierre/diffs is a pinned package, not copied source.
// It is loaded on demand (see splitPackage.ts), so this view is only drawn once it
// has arrived and takes the component as a prop. Import nothing from ./pierreDiff here.

type Props = {
  files: readonly UnifiedDiffFileModel[];
  fill: boolean;
  /** The package's file view. Null when the review only has notes to show. */
  PierreFile: PierreFileComponent | null;
  /** A file to bring to the top, by path or id, as the unified view does. */
  focusPath?: string;
  focusId?: string;
};

function themeName(light: boolean): SplitTheme {
  return light ? "github-light" : "github-dark";
}

export function SplitDiffView({
  files,
  fill,
  PierreFile,
  focusPath,
  focusId,
}: Props) {
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

  return (
    <SplitFiles
      files={files}
      PierreFile={PierreFile}
      theme={themeName(light)}
      fill={fill}
      focus={splitFocusId(files, focusId, focusPath)}
    />
  );
}

function SplitRegion({
  fill,
  regionRef,
  children,
}: {
  fill: boolean;
  regionRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Split diff"
      className={
        fill
          ? "min-h-0 flex-1 overflow-auto bg-transparent"
          : "min-w-0 overflow-x-auto"
      }
    >
      {children}
    </div>
  );
}

/** Events that mean the person is moving the view themselves. */
const SCROLL_INTENT = [
  "wheel",
  "touchstart",
  "pointerdown",
  "keydown",
] as const;

type FilesProps = {
  files: readonly UnifiedDiffFileModel[];
  PierreFile: PierreFileComponent | null;
  theme: SplitTheme;
  fill: boolean;
  focus: string | undefined;
};

/**
 * The region and its files. It first renders once the package has arrived, so
 * the focused file is found and aligned as it mounts.
 */
function SplitFiles({ files, PierreFile, theme, fill, focus }: FilesProps) {
  const region = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  // The file being held at the top. Cleared as soon as the person scrolls.
  const pinned = useRef<string | null>(null);

  const align = () => {
    const id = pinned.current;
    const scroller = region.current;
    const node = id ? nodes.current.get(id) : undefined;
    if (!node || !scroller) return;
    if (!fill) {
      // The page or a parent scrolls, not this region.
      node.scrollIntoView({ block: "start" });
      return;
    }
    const top =
      node.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top);
  };
  const latestAlign = useRef(align);
  latestAlign.current = align;

  useLayoutEffect(() => {
    pinned.current = focus ?? null;
    latestAlign.current();
  }, [focus]);

  // Files above the focused one finish drawing after the first alignment and push
  // it down. Keep it at the top until the person takes over the scrolling.
  useEffect(() => {
    const scroller = region.current;
    const content = list.current;
    if (!scroller || !content) return;
    const release = () => {
      pinned.current = null;
    };
    for (const type of SCROLL_INTENT) {
      scroller.addEventListener(type, release, { passive: true });
    }
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (pinned.current) latestAlign.current();
          });
    resized?.observe(content);
    return () => {
      for (const type of SCROLL_INTENT) {
        scroller.removeEventListener(type, release);
      }
      resized?.disconnect();
    };
  }, []);

  return (
    <SplitRegion fill={fill} regionRef={region}>
      <div ref={list}>
        {files.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-content/45">
            No file changes
          </p>
        ) : (
          files.map((file) => {
            const text = splitFileText(file);
            return (
              <div
                key={file.id}
                data-split-file={file.id}
                ref={(node) => {
                  if (node) nodes.current.set(file.id, node);
                  else nodes.current.delete(file.id);
                }}
              >
                {text ? (
                  PierreFile ? (
                    <SplitBoundary label={text.name}>
                      <PierreFile file={text} theme={theme} />
                    </SplitBoundary>
                  ) : null
                ) : (
                  <FileNote label={file.label}>
                    {file.emptyMessage ??
                      (file.binary
                        ? "Binary file changed"
                        : file.tooLarge
                          ? "Diff is too large to display"
                          : "No textual diff")}
                  </FileNote>
                )}
              </div>
            );
          })
        )}
      </div>
    </SplitRegion>
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
