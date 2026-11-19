import { useEffect, useState, type ComponentType } from "react";
import type { SplitFileText } from "../model/splitDiff";

// WP-116: the one place that loads the split view's package. ./pierreDiff holds
// the pinned @pierre/diffs imports. It is large and starts a highlighter, so it
// is loaded with a dynamic import the first time a file is drawn side by side.
// Nothing may import ./pierreDiff statically, or this would stop being lazy.

export type SplitTheme = "github-light" | "github-dark";

export type PierreFileComponent = ComponentType<{
  file: SplitFileText;
  theme: SplitTheme;
}>;

let loaded: PierreFileComponent | null = null;
let loading: Promise<PierreFileComponent> | null = null;

/** Starts the import once. A failed import is forgotten, so the next try asks again. */
function loadPierreFile(): Promise<PierreFileComponent> {
  loading ??= import("./pierreDiff").then(
    (module) => {
      loaded = module.PierreFile;
      return module.PierreFile;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export type SplitPackage =
  /** Nothing is drawn side by side (no split, or only notes), so no package is needed. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; PierreFile: PierreFileComponent };

/**
 * Loads the package when `needed`: when the review is on Split and has a text
 * file to draw. Until it arrives, and if it never does, the caller keeps the
 * unified view.
 */
export function useSplitPackage(needed: boolean): SplitPackage {
  const [failed, setFailed] = useState(false);
  const [, arrived] = useState(0);

  useEffect(() => {
    if (!needed) return;
    let live = true;
    setFailed(false);
    loadPierreFile().then(
      () => {
        if (live) arrived((count) => count + 1);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [needed]);

  if (!needed) return { status: "idle" };
  if (loaded) return { status: "ready", PierreFile: loaded };
  return { status: failed ? "failed" : "loading" };
}
